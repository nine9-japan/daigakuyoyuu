録音ノート Windows版

使い方
1. ZIPを好きな場所に展開します。
2. RecordingNotes.exe をダブルクリックします。
3. ログイン画面で、管理者が発行したIDを入力します。
4. 初回ログインでは、その場でパスワードを設定します。

保存される内容
- 履歴、録音データ、文字起こし、AIノートは data フォルダに保存されます。
- 「ファイル保存」を押すと data\exports に録音データ、文字起こし.txt、AIノート.md、record.json がまとめて保存されます。
- 録音データは7日で自動削除されます。

ログインと使用制限
- ログインしないと録音ノートは使えません。
- 通常ユーザーは、1日4回まで「録音、文字起こし、ノート作成」の基本機能を使えます。
- 使用回数はIDごとにSupabaseへ記録されます。
- 管理者メニューで使用制限を一時的に解除できます。

管理者メニュー
- 管理者パスワードは gugugu117 です。
- IDを手動発行できます。
- IDをランダム発行できます。
- IDを選んでパスワードリセットできます。リセット後、利用者は次回ログイン時に新しいパスワードを設定します。
- 音声ファイル追加、再文字起こし、簡単なエラーログ確認も管理者メニューから行います。

配布時の注意
- ZIPにOpenAI APIキーやSupabase service_role keyは入れないでください。
- AI処理とログイン管理はRender側のサーバーに置いた秘密情報を使います。
- Windows版の .env には基本的に次のようにRenderのURLだけを入れます。

ADMIN_API_BASE=https://あなたのRenderアプリ.onrender.com
APP_VARIANT=windows

Render側に必要な環境変数
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=Supabaseのservice_roleキー
AUTH_SESSION_SECRET=長いランダム文字列
AUTH_PASSWORD_PEPPER=長いランダム文字列
APP_VARIANT=web
HOST=0.0.0.0
PORT=10000

終了方法
アプリ画面を閉じると終了します。
