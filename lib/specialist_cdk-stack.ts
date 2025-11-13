import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfront_origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as statemachine from 'aws-cdk-lib/aws-stepfunctions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as fs from 'fs';

export class SpecialistCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //DynamoDBの作成
    const table = new dynamodb.Table(this, 'minutes-table', {
      tableName: 'minutes-table',
      partitionKey: { name: 'job_id', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });

    // Web用S3バケットの作成
    const webBucket = new s3.Bucket(this, 'minutes-web-bucket', {
      bucketName: 'minutes-web-bucket',
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // データ格納用S3バケットの作成
    const dataBucket = new s3.Bucket(this, 'minutes-data-bucket', {
      bucketName: 'minutes-data-bucket',
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    //assets/web/の配下をS3にアップロード
    new s3deploy.BucketDeployment(this, 'DeployContents', {
      sources: [s3deploy.Source.asset('./assets/web/')],
      destinationBucket: webBucket,
    });

    //CloudFrontのOACを作成
    const oac = new cloudfront.CfnOriginAccessControl(this, 'minutes-oac', {
      originAccessControlConfig: {
        name: 'minutes-oac',
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    //CloudFrontを作成し、S3をホスト
    const distribution = new cloudfront.Distribution(this, 'minutes-distribution', {
      defaultBehavior: { 
        origin: cloudfront_origins.S3BucketOrigin.withOriginAccessControl(webBucket) 
      },
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200
    });

    //自動生成されるS3バケットのOAI用ポリシーを削除
    const cfnBucket = webBucket.node.defaultChild as s3.CfnBucket;
    cfnBucket.accessControl = undefined;

    //OACとディストリビューションを関連付ける
    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;

    //自動生成されるOAIを削除
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity', '');

    //OACの設定
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', oac.attrId);

    // OACをS3バケットに関連付けるポリシーを追加
    const bucketPolicy = new s3.CfnBucketPolicy(this, 'minutes-web-bucketpolicy', {
      bucket: webBucket.bucketName,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'cloudfront.amazonaws.com',
            },
            Action: 's3:GetObject',
            Resource: `${webBucket.bucketArn}/*`,
            Condition: {
              StringEquals: {
                'AWS:SourceArn': `arn:aws:cloudfront::${cdk.Stack.of(this).account}:distribution/${distribution.distributionId}`,
              },
            },
          },
        ],
      },
    });

    // バケットポリシーがバケットの後に作成されるようにする
    bucketPolicy.node.addDependency(webBucket);

    //Cognito ユーザプールを定義
    const userPool = new cognito.UserPool(this, 'minutes-UserPool', {
      userPoolName: 'MinutesUserPool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // User Pool Domain
    const userPoolDomain = userPool.addDomain('minutes-userpool-domain', {
      cognitoDomain: {
        domainPrefix: `minutes-domain-${cdk.Stack.of(this).account}`,
      },
    });

    // User Pool Client (CloudFrontのコールバックURL設定)
    const userPoolClient = userPool.addClient('minutes-web-client', {
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [
          `https://${distribution.distributionDomainName}`,
          `https://${distribution.distributionDomainName}/`,
        ],
        logoutUrls: [
          `https://${distribution.distributionDomainName}`,
        ],
      },
      generateSecret: false,
    });

    // Identity Pool作成
    const identityPool = new cognito.CfnIdentityPool(this, 'minutes-IdentityPool', {
      identityPoolName: 'MinutesIdentityPool',
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [{
        clientId: userPoolClient.userPoolClientId,
        providerName: userPool.userPoolProviderName,
      }],
    });

    // 認証済みユーザー用IAMロール
    const authenticatedRole = new iam.Role(this, 'minutes-AuthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'authenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
    });

    // S3アクセス権限
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
      ],
      resources: [`${dataBucket.bucketArn}/*`],
    }));

    // DynamoDBアクセス権限
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ],
      resources: [table.tableArn],
    }));

    // Identity Poolにロールをアタッチ
    new cognito.CfnIdentityPoolRoleAttachment(this, 'minutes-IdentityPoolRoleAttachment', {
      identityPoolId: identityPool.ref,
      roles: {
        authenticated: authenticatedRole.roleArn,
      },
    });

    // Comprehend用IAMロール
    const comprehendRole = new iam.Role(this, 'minutes-ComprehendRole', {
      roleName: 'minutes-app-team-a-iamrole_comprehend',
      assumedBy: new iam.ServicePrincipal('comprehend.amazonaws.com'),
    });

    comprehendRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [`${dataBucket.bucketArn}/*`],
    }));

    //ステートマシン用のIAMロールを作成
    const statemachineRole = new iam.Role(this, 'minutes-StateMachineRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com')
    });

    // Transcribe権限
    statemachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'transcribe:StartTranscriptionJob',
        'transcribe:GetTranscriptionJob',
      ],
      resources: ['*'],
    }));

    // Bedrock権限
    statemachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));

    // Comprehend権限
    statemachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'comprehend:StartSentimentDetectionJob',
        'comprehend:DescribeSentimentDetectionJob',
      ],
      resources: ['*'],
    }));

    // IAM PassRole権限
    statemachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [comprehendRole.roleArn],
    }));

    // S3権限
    statemachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:CopyObject',
      ],
      resources: [`${dataBucket.bucketArn}/*`],
    }));

    // DynamoDB権限
    statemachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:UpdateItem'],
      resources: [table.tableArn],
    }));

    const file = fs.readFileSync('./assets/code/statemachine.json')

    //ステートマシンを作成
    const stateMachine = new statemachine.CfnStateMachine(this, 'minutes-state-machine', {
      stateMachineName: 'MinutesStateMachine',
      definitionString:file.toString(),
      roleArn:statemachineRole.roleArn
    });

    // S3バケットのEventBridge有効化
    const cfnDataBucket = dataBucket.node.defaultChild as s3.CfnBucket;
    cfnDataBucket.notificationConfiguration = {
      eventBridgeConfiguration: {
        eventBridgeEnabled: true,
      },
    };

    // EventBridgeルール: input-data/フォルダへのPutObject時にステートマシン起動
    const rule = new events.Rule(this, 'minutes-S3EventRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [dataBucket.bucketName] },
          object: { key: [{ prefix: 'input-data/' }] },
        },
      },
    });

    rule.addTarget(new targets.SfnStateMachine(
      statemachine.StateMachine.fromStateMachineArn(
        this,
        'TargetStateMachine',
        stateMachine.attrArn
      )
    ));

    // === 出力 ===
    new cdk.CfnOutput(this, 'WebsiteURL', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront URL',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito App Client ID',
    });

    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: identityPool.ref,
      description: 'Cognito Identity Pool ID',
    });

    new cdk.CfnOutput(this, 'DataBucketName', {
      value: dataBucket.bucketName,
      description: 'Data S3 Bucket Name',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB Table Name',
    });

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.attrArn,
      description: 'Step Functions State Machine ARN',
    });

  }
}
