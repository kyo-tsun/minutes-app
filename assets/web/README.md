# 議事録AI分析アプリ - Web UI

## 概要
音声ファイル（MP3/MP4）から文字起こし、議事録要約、感情分析を行うWebアプリケーションのフロントエンド部分です。

## 機能
- **ファイルアップロード**: MP3/MP4ファイルのドラッグ&ドロップアップロード
- **リアルタイム進捗表示**: プログレスバーで処理状況を可視化
  - アップロード完了
  - 文字起こし中（Amazon Transcribe）
  - 要約生成中（Amazon Bedrock）
  - 感情分析中（Amazon Comprehend）
  - 処理完了
- **結果ダウンロード**: 
  - 文字起こしテキスト（.txt）
  - 議事録要約（.html）
  - 感情分析結果（.tar.gz）

## システム構成

### フロントエンド
- 静的HTML/CSS/JavaScript（S3 + CloudFront）
- AWS SDK for JavaScript（ブラウザ版）
- Amazon Cognito認証

### バックエンド
- AWS Step Functions（処理ワークフロー）
- Amazon DynamoDB（ジョブ管理・進捗状況）
- Amazon S3（ファイル保存）
- Amazon Transcribe（文字起こし）
- Amazon Bedrock（議事録要約）
- Amazon Comprehend（感情分析）

## ファイル構成
```
web/
├── index.html          # メインページ（アップロード・進捗表示・ダウンロード）
├── css/
│   └── style.css       # スタイルシート（プログレスバー含む）
├── js/
│   ├── config.js       # AWS設定管理
│   ├── auth.js         # Cognito認証管理
│   ├── s3-client.js    # S3操作クライアント
│   ├── dynamo-client.js # DynamoDB操作クライアント
│   ├── upload.js       # ファイルアップロード機能
│   └── main.js         # プログレス管理・ダウンロード機能
├── deploy.js           # 本番環境設定
└── README.md           # このファイル
```

## 使用方法

### 1. ファイルアップロード
1. MP3またはMP4ファイルをドラッグ&ドロップ、または「ファイルを選択」ボタンをクリック
2. ファイルサイズ制限: 最大100MB
3. アップロード完了後、ジョブIDが表示されます

### 2. 進捗確認
- プログレスバーが自動的に表示され、3秒ごとに処理状況を更新
- 処理ステータス:
  - **アップロード完了** (20%)
  - **文字起こし中** (40%)
  - **要約生成中** (60%)
  - **感情分析中** (80%)
  - **処理完了** (100%)

### 3. ファイルダウンロード
1. ジョブID入力欄に表示されたジョブIDを確認
2. 処理完了後、各ボタンをクリックしてダウンロード:
   - **文字起こし**: テキストファイル
   - **要約**: HTML形式の議事録
   - **感情分析**: tar.gz形式の分析結果

## 本番環境デプロイ

### 事前準備
必要なAWSリソースが作成済みであることを確認:
- S3バケット（静的サイトホスティング設定済み）
- CloudFront（配信）
- Cognito User Pool & Identity Pool
- DynamoDB テーブル（`minutes-app-team-a-dynamodb`）
- Step Functions（処理ワークフロー）
- IAM ロール・ポリシー

### デプロイ手順

#### 1. AWS設定確認
`js/config.js` の設定値を確認:
```javascript
userPoolId: 'ap-northeast-1_IZajChZJD'
clientId: '7k7s2cko3vdf94lfghdac07dc0'
identityPoolId: 'ap-northeast-1:865e8342-6bbc-4f1f-ba5b-0c07164b112e'
bucketName: 'minutes-app-team-a-backet'
dynamoTableName: 'minutes-app-team-a-dynamodb'
```

#### 2. S3バケットへアップロード
```bash
# webフォルダに移動
cd gijirokuapps/web

# S3バケットに同期アップロード
aws s3 sync . s3://minutes-app-team-a-web-backet/ --delete
```

#### 3. CloudFront無効化（キャッシュクリア）
```bash
aws cloudfront create-invalidation --distribution-id YOUR_DISTRIBUTION_ID --paths "/*"
```

### アクセスURL
- 本番環境: https://d1lygg7omlk19y.cloudfront.net/

## 技術仕様

### 認証
- Amazon Cognito User Pool認証
- Identity Poolで一時的なAWS認証情報を取得
- S3、DynamoDBへの直接アクセス

### プログレスバー実装
- DynamoDBから3秒ごとにジョブステータスをポーリング
- Step Functionsが各処理段階でDynamoDBを更新
- ステータス: `UPLOADED` → `TRANSCRIBING` → `SUMMARIZING` → `ANALYZING` → `COMPLETED`

### Job ID管理
- フォーマット: `job_TIMESTAMP_RANDOM`（先頭3要素のみ）
- 例: `job_1762999058153_7qt2o54zq`
- フロントエンドとStep Functionsで統一

### エラーハンドリング
- ファイル検証（形式・サイズ）
- AWS SDK エラーハンドリング
- DynamoDB接続エラー時はコンソールログのみ

## トラブルシューティング

### プログレスバーが更新されない
1. ブラウザコンソール（F12）でログを確認
2. DynamoDBでジョブステータスを確認
3. Step Functionsの実行履歴を確認

### ダウンロードエラー
1. ジョブIDが正しいか確認
2. 処理が完了しているか確認（ステータス: `COMPLETED`）
3. S3バケットにファイルが存在するか確認

### 認証エラー
1. Cognito ID Tokenの有効期限を確認
2. Identity Poolの権限を確認
3. ブラウザのローカルストレージをクリアして再ログイン

## セキュリティ

- HTTPS通信（CloudFront）
- Cognito認証必須
- IAM権限の最小化
- Pre-signed URLは使用せず、Identity Pool認証で直接アクセス

## パフォーマンス

- 処理時間: 5分の音声ファイルで約3-5分
- ポーリング間隔: 3秒（DynamoDB料金考慮）
- 同時処理: Step Functionsで自動スケーリング

## 今後の拡張予定
- [ ] WebSocket（API Gateway）でリアルタイム通知
- [ ] 処理時間の予測表示
- [ ] 複数ファイルの並行処理
- [ ] プッシュ通知（処理完了時）
- [ ] 履歴管理機能

## ライセンス
MIT License

## 作成者
kyonosuke-specialist
