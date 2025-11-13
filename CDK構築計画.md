# 議事録感情分析アプリ CDK構築計画

## 1. 現状把握

### 1.1 既存アプリケーション構成
- **フロントエンド**: 静的Webサイト (HTML/CSS/JavaScript)
- **認証**: Amazon Cognito (User Pool + Identity Pool)
- **ストレージ**: S3バケット (入力/出力ファイル)
- **データベース**: DynamoDB (ジョブ管理)
- **ワークフロー**: Step Functions (Transcribe → Bedrock → Comprehend)
- **配信**: CloudFront

### 1.2 既存リソース名
- S3バケット: `minutes-app-team-a-backet`
- DynamoDBテーブル: `minutes-app-team-a-dynamodb`
- Cognito User Pool: `ap-northeast-1_IZajChZJD`
- Cognito App Client: `7k7s2cko3vdf94lfghdac07dc0`
- Cognito Identity Pool: `ap-northeast-1:865e8342-6bdc-4f1f-ba5b-0c07164b112e`
- CloudFront URL: `https://d1lygg7omlk19y.cloudfront.net/`

## 2. CDK構築方針

### 2.1 基本方針
- **Lambdaは使用しない** (ルール遵守)
- **既存リソースをCDKで再構築**
- **IaCによる管理可能な構成**
- **環境変数による設定管理**

### 2.2 CDKスタック構成
```
specialist_cdk/
├── bin/
│   └── specialist_cdk.ts          # エントリーポイント
├── lib/
│   └── specialist_cdk-stack.ts    # メインスタック (全リソース定義)
└── assets/
    ├── web/                       # Webアプリファイル
    └── statemachine.json          # Step Functions定義
```

## 3. リソース詳細設計

### 3.1 S3バケット

**目的**: 音声ファイル、処理結果の保存

**リソース**:
- S3バケット (1個)
  - バケット名: `minutes-app-team-a-backet`
  - バージョニング: 無効
  - 暗号化: SSE-S3
  - CORS設定: あり (Webアップロード用)
  - ライフサイクル: 90日後削除

**フォルダ構成**:
```
minutes-app-team-a-backet/
├── input-data/           # アップロード音声ファイル
├── output-transcribe/    # 文字起こし結果
├── output-bedrock/       # 議事録要約結果
├── output-comprehend/    # 感情分析結果
└── output-comprehend_temp/ # Comprehend一時出力
```

**イベント通知**:
- EventBridge通知有効化
- `input-data/` プレフィックスのPutObject時にStep Functions起動

**CDKコード概要**:
```typescript
// メインスタック内で定義
const bucket = new s3.Bucket(this, 'MinutesAppBucket', {
  bucketName: 'minutes-app-team-a-backet',
  encryption: s3.BucketEncryption.S3_MANAGED,
  cors: [/* CORS設定 */],
  lifecycleRules: [/* 90日削除 */],
  eventBridgeEnabled: true,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true
});
```

---

### 3.2 Cognito認証

**目的**: ユーザー認証とAWSリソースアクセス権限管理

**リソース**:
1. **Cognito User Pool**
   - ユーザー名/パスワード認証
   - メール検証なし (簡易構成)
   - パスワードポリシー: 最小8文字

2. **Cognito User Pool Client**
   - OAuth2.0フロー: Authorization Code Grant
   - コールバックURL: CloudFront URL
   - スコープ: openid

3. **Cognito Identity Pool**
   - User Poolと連携
   - 認証済みユーザーロール付与

4. **IAMロール (認証済みユーザー)**
   - S3アクセス権限 (アップロード/ダウンロード)
   - DynamoDBアクセス権限 (読み取り/書き込み)

**CDKコード概要**:
```typescript
// メインスタック内で定義
const userPool = new cognito.UserPool(this, 'UserPool', {
  selfSignUpEnabled: true,
  signInAliases: { username: true, email: true },
  passwordPolicy: { minLength: 8 }
});

const userPoolClient = userPool.addClient('WebClient', {
  oAuth: {
    flows: { authorizationCodeGrant: true },
    scopes: [cognito.OAuthScope.OPENID],
    callbackUrls: [distributionUrl]
  }
});

const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
  allowUnauthenticatedIdentities: false,
  cognitoIdentityProviders: [/* User Pool連携 */]
});

const authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
  assumedBy: new iam.FederatedPrincipal(/* Cognito Identity */),
  inlinePolicies: {
    's3Access': new iam.PolicyDocument({/* S3ポリシー */}),
    'dynamoAccess': new iam.PolicyDocument({/* DynamoDBポリシー */})
  }
});
```

---

### 3.3 DynamoDB

**目的**: ジョブ処理状況の管理

**リソース**:
- DynamoDBテーブル
  - テーブル名: `minutes-app-team-a-dynamodb`
  - パーティションキー: `job_id` (String)
  - 課金モード: オンデマンド
  - ポイントインタイムリカバリ: 無効

**属性**:
```
- job_id (String, PK): ジョブID
- user_id (String): ユーザーID
- file_name (String): ファイル名
- file_size (Number): ファイルサイズ
- file_type (String): ファイルタイプ
- status (String): 処理状況 (UPLOADED, TRANSCRIBING, SUMMARIZING, ANALYZING, COMPLETED, ERROR)
- created_at (String): 作成日時
- updated_at (String): 更新日時
- s3_upload_key (String): S3アップロードキー
- transcript_s3_key (String): 文字起こし結果S3キー
- summary_s3_key (String): 要約結果S3キー
- sentiment_s3_key (String): 感情分析結果S3キー
- error_message (String): エラーメッセージ
```

**CDKコード概要**:
```typescript
// メインスタック内で定義
const table = new dynamodb.Table(this, 'JobsTable', {
  tableName: 'minutes-app-team-a-dynamodb',
  partitionKey: { name: 'job_id', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  removalPolicy: RemovalPolicy.DESTROY
});
```

---

### 3.4 Step Functions

**目的**: 音声ファイル処理ワークフロー

**リソース**:
1. **Step Functions State Machine**
   - 定義ファイル: `statemachine.json`
   - トリガー: EventBridge (S3 PutObject)

2. **IAMロール (Step Functions実行ロール)**
   - Transcribe実行権限
   - Bedrock実行権限
   - Comprehend実行権限
   - S3読み書き権限
   - DynamoDB更新権限

3. **IAMロール (Comprehend用)**
   - S3読み書き権限 (入出力用)

4. **EventBridge Rule**
   - イベントパターン: S3 PutObject (`input-data/` プレフィックス)
   - ターゲット: Step Functions

**処理フロー**:
```
S3 PutObject (input-data/)
  ↓
EventBridge Rule
  ↓
Step Functions起動
  ↓
1. ジョブID抽出
2. DynamoDB更新 (TRANSCRIBING)
3. Transcribe実行 (MP3/MP4)
4. 文字起こし結果取得
5. TXT形式で保存
6. DynamoDB更新 (SUMMARIZING)
7. 並列処理:
   - Bedrock要約 → S3保存
   - Comprehend感情分析 → S3保存
8. DynamoDB更新 (COMPLETED)
```

**CDKコード概要**:
```typescript
// メインスタック内で定義
const comprehendRole = new iam.Role(this, 'ComprehendRole', {
  roleName: 'minutes-app-team-a-iamrole_comprehend',
  assumedBy: new iam.ServicePrincipal('comprehend.amazonaws.com'),
  inlinePolicies: {/* S3アクセス */}
});

const stateMachineRole = new iam.Role(this, 'StateMachineRole', {
  assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
  inlinePolicies: {
    'transcribe': new iam.PolicyDocument({/* Transcribe */}),
    'bedrock': new iam.PolicyDocument({/* Bedrock */}),
    'comprehend': new iam.PolicyDocument({/* Comprehend */}),
    's3': new iam.PolicyDocument({/* S3 */}),
    'dynamodb': new iam.PolicyDocument({/* DynamoDB */})
  }
});

const definitionBody = sfn.DefinitionBody.fromFile(
  path.join(__dirname, '../assets/statemachine.json')
);

const stateMachine = new sfn.StateMachine(this, 'ProcessingStateMachine', {
  stateMachineName: 'minutes-app-processing',
  definitionBody: definitionBody,
  role: stateMachineRole
});

const rule = new events.Rule(this, 'S3PutObjectRule', {
  eventPattern: {
    source: ['aws.s3'],
    detailType: ['Object Created'],
    detail: {
      bucket: { name: [bucket.bucketName] },
      object: { key: [{ prefix: 'input-data/' }] }
    }
  }
});

rule.addTarget(new targets.SfnStateMachine(stateMachine));
```

---

### 3.5 CloudFront + S3

**目的**: 静的Webサイトの配信

**リソース**:
1. **S3バケット (Web用)**
   - バケット名: 自動生成
   - パブリックアクセス: ブロック
   - OAI経由でCloudFrontからのみアクセス

2. **CloudFront Distribution**
   - オリジン: S3バケット (OAI使用)
   - デフォルトルートオブジェクト: `index.html`
   - エラーページ: `index.html` (SPA対応)
   - HTTPS強制

3. **S3 Deployment**
   - ソース: `assets/web/`
   - デプロイ時に自動アップロード

**CDKコード概要**:
```typescript
// メインスタック内で定義
const webBucket = new s3.Bucket(this, 'WebBucket', {
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true
});

const oai = new cloudfront.OriginAccessIdentity(this, 'OAI');
webBucket.grantRead(oai);

const distribution = new cloudfront.Distribution(this, 'Distribution', {
  defaultBehavior: {
    origin: new origins.S3Origin(webBucket, { originAccessIdentity: oai }),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
  },
  defaultRootObject: 'index.html',
  errorResponses: [
    { httpStatus: 404, responsePagePath: '/index.html', responseHttpStatus: 200 }
  ]
});

new s3deploy.BucketDeployment(this, 'DeployWeb', {
  sources: [s3deploy.Source.asset(path.join(__dirname, '../assets/web'))],
  destinationBucket: webBucket,
  distribution: distribution,
  distributionPaths: ['/*']
});
```

---

## 4. メインスタック構成

### 4.1 specialist_cdk-stack.ts (全リソース定義)

```typescript
export class SpecialistCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // === 1. S3バケット (データ保存用) ===
    const bucket = new s3.Bucket(this, 'MinutesAppBucket', {
      bucketName: 'minutes-app-team-a-backet',
      encryption: s3.BucketEncryption.S3_MANAGED,
      cors: [/* CORS設定 */],
      lifecycleRules: [/* 90日削除 */],
      eventBridgeEnabled: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    // === 2. DynamoDB ===
    const table = new dynamodb.Table(this, 'JobsTable', {
      tableName: 'minutes-app-team-a-dynamodb',
      partitionKey: { name: 'job_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    // === 3. CloudFront + S3 (Web配信) ===
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    const oai = new cloudfront.OriginAccessIdentity(this, 'OAI');
    webBucket.grantRead(oai);

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(webBucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 404, responsePagePath: '/index.html', responseHttpStatus: 200 }
      ]
    });

    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../assets/web'))],
      destinationBucket: webBucket,
      distribution: distribution,
      distributionPaths: ['/*']
    });

    // === 4. Cognito認証 ===
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { username: true, email: true },
      passwordPolicy: { minLength: 8 }
    });

    const userPoolClient = userPool.addClient('WebClient', {
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: [`https://${distribution.distributionDomainName}`]
      }
    });

    const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [/* User Pool連携 */]
    });

    const authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(/* Cognito Identity */),
      inlinePolicies: {
        's3Access': new iam.PolicyDocument({/* S3ポリシー */}),
        'dynamoAccess': new iam.PolicyDocument({/* DynamoDBポリシー */})
      }
    });

    // === 5. Step Functions ===
    const comprehendRole = new iam.Role(this, 'ComprehendRole', {
      roleName: 'minutes-app-team-a-iamrole_comprehend',
      assumedBy: new iam.ServicePrincipal('comprehend.amazonaws.com'),
      inlinePolicies: {/* S3アクセス */}
    });

    const stateMachineRole = new iam.Role(this, 'StateMachineRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      inlinePolicies: {
        'transcribe': new iam.PolicyDocument({/* Transcribe */}),
        'bedrock': new iam.PolicyDocument({/* Bedrock */}),
        'comprehend': new iam.PolicyDocument({/* Comprehend */}),
        's3': new iam.PolicyDocument({/* S3 */}),
        'dynamodb': new iam.PolicyDocument({/* DynamoDB */})
      }
    });

    const definitionBody = sfn.DefinitionBody.fromFile(
      path.join(__dirname, '../assets/statemachine.json')
    );

    const stateMachine = new sfn.StateMachine(this, 'ProcessingStateMachine', {
      stateMachineName: 'minutes-app-processing',
      definitionBody: definitionBody,
      role: stateMachineRole
    });

    const rule = new events.Rule(this, 'S3PutObjectRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [bucket.bucketName] },
          object: { key: [{ prefix: 'input-data/' }] }
        }
      }
    });

    rule.addTarget(new targets.SfnStateMachine(stateMachine));

    // === 出力 ===
    new cdk.CfnOutput(this, 'WebsiteURL', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront URL'
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID'
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito App Client ID'
    });

    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: identityPool.ref,
      description: 'Cognito Identity Pool ID'
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 Bucket Name'
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB Table Name'
    });
  }
}
```

---

## 5. デプロイ手順

### 5.1 前提条件
- Node.js 18以上
- AWS CLI設定済み
- AWS CDK CLI インストール済み (`npm install -g aws-cdk`)
- SSO認証設定済み

### 5.2 デプロイコマンド
```bash
# 1. 依存関係インストール
cd specialist_cdk
npm install

# 2. CDKブートストラップ (初回のみ)
cdk bootstrap

# 3. 差分確認
cdk diff

# 4. デプロイ
cdk deploy

# 5. 出力値確認
# CloudFront URL、Cognito設定値などが表示される
```

### 5.3 デプロイ後の設定
1. **Webアプリ設定ファイル更新**
   - `web/js/config.js` にCDK出力値を反映
   - 再デプロイ: `cdk deploy` (自動的にS3にアップロード)

2. **Cognitoユーザー作成**
   ```bash
   aws cognito-idp admin-create-user \
     --user-pool-id <UserPoolId> \
     --username testuser \
     --temporary-password TempPass123!
   ```

3. **動作確認**
   - CloudFront URLにアクセス
   - ログイン
   - ファイルアップロード
   - 処理完了確認
   - ダウンロード

---

## 6. 削除手順

```bash
# スタック削除
cdk destroy

# 確認プロンプトで 'y' を入力
```

---

## 7. 開発タスク一覧

### Phase 1: CDK基盤構築 (2時間)
- [ ] メインスタックファイル実装 (specialist_cdk-stack.ts)
- [ ] statemachine.json配置
- [ ] Webアプリファイル配置 (assets/web/)

### Phase 2: リソース定義 (2時間)
- [ ] S3バケット設定 (CORS、ライフサイクル、EventBridge)
- [ ] DynamoDBテーブル設計
- [ ] Cognito認証設定 (User Pool、Identity Pool、IAMロール)
- [ ] Step Functions定義 (statemachine.json配置)
- [ ] IAMポリシー設定

### Phase 3: デプロイ・テスト (2時間)
- [ ] CDKデプロイ
- [ ] Webアプリ設定更新
- [ ] 動作確認
  - [ ] 認証フロー
  - [ ] ファイルアップロード
  - [ ] Step Functions実行
  - [ ] 結果ダウンロード
- [ ] バグ修正

### Phase 4: ドキュメント作成 (1時間)
- [ ] README更新
- [ ] デプロイ手順書
- [ ] トラブルシューティングガイド

---

## 8. 注意事項

### 8.1 既存リソースとの互換性
- 既存のバケット名、テーブル名を使用する場合は、CDKで既存リソースをインポートする必要がある
- 新規構築の場合は、既存リソースを削除してからCDKデプロイを推奨

### 8.2 コスト管理
- DynamoDB: オンデマンド課金
- S3: ストレージ + リクエスト課金
- CloudFront: データ転送課金
- Transcribe: 処理時間課金
- Bedrock: トークン課金
- Comprehend: 処理文字数課金

### 8.3 セキュリティ
- S3バケットはパブリックアクセスブロック
- Cognito認証必須
- HTTPS通信強制
- IAMロール最小権限の原則

---

## 9. 今後の拡張

### 9.1 機能拡張
- [ ] プログレスバー表示 (WebSocket API Gateway)
- [ ] 複数ファイル同時アップロード
- [ ] ファイル削除機能
- [ ] ユーザー管理画面

### 9.2 運用改善
- [ ] CloudWatch Logs監視
- [ ] SNS通知 (処理完了/エラー)
- [ ] X-Ray トレーシング
- [ ] コスト最適化

---

## 10. 参考資料

- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
- [Step Functions Developer Guide](https://docs.aws.amazon.com/step-functions/)
- [Cognito Developer Guide](https://docs.aws.amazon.com/cognito/)
- [S3 Event Notifications](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html)
