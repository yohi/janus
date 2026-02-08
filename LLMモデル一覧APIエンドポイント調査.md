# **大規模言語モデル（LLM）動的探索エンドポイントの包括的技術解析：OpenAI、Anthropic、Googleのアーキテクチャ比較と実装戦略**

## **エグゼクティブサマリー**

現代のAIシステムアーキテクチャにおいて、推論モデルの「動的探索（Dynamic Discovery）」は、システムの堅牢性と適応性を保証するための不可欠な要素となっている。静的なモデルID（例: "gpt-4", "claude-3-opus"）をソースコード内にハードコードする従来の手法は、モデルのライフサイクルが極めて高速に回転する現在の環境下では、技術的負債の主要因となりつつある。これに対し、APIプロバイダーが提供する「モデル一覧取得（List Models）」エンドポイントは、利用可能なモデルのリストをプログラム的に取得し、その機能や制約（コンテキストウィンドウ、モーダルサポート等）に基づいて動的にリクエストをルーティングするための基盤を提供する。

本リサーチレポートは、主要なLLMプロバイダーであるOpenAI、Anthropic、およびGoogle（Google AI StudioとVertex AIの両エコシステムを含む）が提供するモデル一覧取得APIエンドポイントについて、その仕様、レスポンス構造、認証メカニズム、およびアーキテクチャ上の意図を徹底的に分析したものである。

調査の結果、全プロバイダーがモデル一覧を取得するためのREST APIエンドポイントを提供していることが確認された。しかし、その設計思想は大きく異なる。OpenAIは最小限のメタデータのみを返す軽量な設計を採用し、事実上の業界標準となっている。Anthropicは、ページネーションやベータ機能ヘッダーによる制御を導入し、将来的なモデル数の増大（ファインチューニングモデル等）を見越したエンタープライズ向けの設計志向を持つ。Googleは二極化しており、Gemini API（AI Studio）ではコンテキストウィンドウやサポートメソッドを含む最もリッチなメタデータを提供する一方、Vertex AIでは「Publisher Model（基盤モデル）」と「User Model（ユーザーデプロイモデル）」を明確に区別する複雑なリソース階層を採用している。

本レポートでは、これらのエンドポイントの技術的詳細を解剖し、開発者が直面する実装上の課題（レート制限、リージョン制約、メタデータの欠如への対処）に対する具体的な解決策を提示する。

---

**1. 現代AIアーキテクチャにおけるモデル探索のパラダイム**

特定のAPIエンドポイントの技術的仕様に入る前に、なぜ「モデル一覧取得」という機能が現代のソフトウェアエンジニアリングにおいて決定的な意味を持つのか、その構造的背景を理解する必要がある。

### **1.1 静的定義から動的探索への移行**

初期のLLM統合アプリケーションでは、利用するモデルIDを環境変数や定数として定義することが一般的であった。しかし、このアプローチは以下の要因により限界を迎えている。

1. **急速な減価償却（Deprecation）サイクル:** モデルのバージョン更新（例: gpt-4-0613 から gpt-4-0125-preview へ）は頻繁に行われ、古いスナップショットは予告なく、あるいは短い猶予期間で廃止される。動的探索を行わないシステムは、モデル廃止のたびにコードの修正と再デプロイを余儀なくされる。  
2. **機能ごとのルーティング要件:** すべてのタスクに最上位モデルを使用するのはコスト効率が悪い。入力トークン数やタスクの難易度に応じて、軽量モデル（例: gpt-3.5-turbo, claude-3-haiku, gemini-1.5-flash）と高機能モデルを動的に切り替える「AIルーター」パターンが主流となっている。このルーティングロジックを維持するためには、現在利用可能なモデルとそのプロパティをリアルタイムで把握する必要がある。  
3. **マルチテナント環境での権限管理:** エンタープライズ環境では、同一の組織内でも部署やプロジェクトによってアクセス可能なモデルが異なる場合がある（例: 特定の部署のみがGPT-4の32kコンテキスト版や、社内データでファインチューニングされたモデルにアクセスできる）。APIキーの権限に基づいて動的にリストを取得することで、UI上に適切な選択肢のみを表示することが可能になる。

### **1.2 「OpenAI互換」というデファクトスタンダード**

OpenAIが定義した GET /v1/models というエンドポイント構造は、AI業界における一種のインターフェース規約（Contract）として機能している 1。vLLM、Text Generation Inference (TGI)、LocalAI、LM Studioといったオープンソースの推論サーバーや、OpenRouterのようなモデルアグリゲーターの多くは、このエンドポイント仕様を模倣している 2。これにより、クライアントライブラリは接続先URLを変更するだけで、バックエンドの実装を意識することなく利用可能なモデル一覧を取得できる。この「互換性」の重力が、競合他社のAPI設計にも影響を与えている側面は否定できない。

---

**2. OpenAI: ミニマリズムと業界標準の仕様**

OpenAIのモデル一覧取得エンドポイントは、最も広く利用されており、多くの開発者にとってのベースラインとなっている。その設計は極めてシンプルであり、必要最小限の情報のみを返す「Unix哲学」的なアプローチが見て取れる。

### **2.1 エンドポイント仕様とアクセス方法**

OpenAIにおけるモデル探索の主要なインターフェースは以下の通りである。

* **エンドポイントURL:** https://api.openai.com/v1/models 1  
* **HTTPメソッド:** GET  
* **認証方式:** Bearer Token（標準APIキー）  
  * ヘッダー: Authorization: Bearer $OPENAI_API_KEY

このエンドポイントは、リクエストを行ったAPIキー（およびそのキーが属する組織・プロジェクト）が利用権限を持つモデルのリストのみを返す 5。つまり、GPT-4へのアクセス権がないAPIキーでこのエンドポイントを叩いた場合、レスポンスのリストには gpt-4 は含まれない。これは、クライアント側で「このユーザーはどのモデルを使えるか」を判定するための権限検証APIとしても機能することを意味する。

### **2.2 レスポンススキーマの構造解析**

OpenAIのレスポンスはJSON形式であり、その構造は長らく変更されていない安定したものである。

**標準的なレスポンス例:**

```json
{  
  "object": "list",  
  "data":  
}
```

**フィールド詳細分析:**

* **id (string):** 推論API（Completions/Chat Completions）の model パラメータに指定する識別子。エイリアス（例: gpt-4）と特定のスナップショット（例: gpt-4-0613）が混在して返される 4。  
* **object (string):** リソースタイプを示す。常に "model" である。  
* **created (integer):** モデルがプラットフォームに登録された日時のUnixタイムスタンプ。これはモデルの「学習カットオフ日」ではなく、APIとしての「リリース日」である点に注意が必要である 4。  
* **owned_by (string):** モデルの所有者。公式の基盤モデルの場合は通常 "system" または "openai" となる。ユーザーが作成したファインチューニングモデルの場合は、組織IDやユーザー識別子が入る 4。

### **2.3 メタデータの欠如とアーキテクチャへの影響**

OpenAIのエンドポイントにおける最大の技術的制約は、**機能的メタデータの欠如**である 6。レスポンスには以下の情報が含まれていない。

1. **コンテキストウィンドウサイズ:** モデルが処理可能な最大トークン数（例: 4k, 8k, 128k）。  
2. **モダリティサポート:** 画像入力（Vision）や音声入出力に対応しているかどうかのフラグ。  
3. **コスト情報:** 入力/出力トークンあたりの単価。  
4. **トレーニングデータカットオフ:** モデルがいつまでの知識を持っているか。

**インプリケーション:** この情報の欠如は、開発者に対し、アプリケーション側で「モデルIDとスペックのマッピングテーブル」をハードコードして維持することを強制する 6。例えば、APIから gpt-4-turbo というIDが返ってきても、プログラムはそれが128kトークンまで受け付けることをAPIレスポンスからは知ることができない。したがって、LangChainやLlamaIndexなどの主要なライブラリは、内部的に巨大な辞書ファイルを持ち、モデルIDごとのスペックを静的に管理している。これは、OpenAIが新しいモデルをリリースするたびにライブラリのアップデートが必要になるという、エコシステム全体へのメンテナンスコストを発生させている。

### **2.4 プロジェクトスコープと権限管理**

最近のアップデートにより、OpenAIは「Project（プロジェクト）」という概念を導入した。APIキーは特定のプロジェクトに紐づけられ、プロジェクトごとに利用可能なモデルを制限できる。 GET /v1/models エンドポイントは、このプロジェクト設定を正しく反映する。したがって、あるプロジェクトで gpt-4 の使用を禁止している場合、そのプロジェクトのAPIキーを使用したリスト取得リクエストの結果には gpt-4 が含まれない。これにより、管理者は開発者が使用するモデルをサーバーサイドで制御し、クライアントアプリ（一覧取得を行ってUIを構築するアプリ）に即座に反映させることが可能となる 5。

---

**3. Anthropic: エンタープライズグレードのライフサイクル管理**

AnthropicのAPI設計は、RESTfulな原則に従いつつも、大規模な運用と将来の拡張性を見据えた高度な機能を備えている。特にページネーションとバージョニングに対する厳格なアプローチは、同社がエンタープライズ顧客を重視している姿勢を反映している。

### **3.1 エンドポイント仕様と必須ヘッダー**

Anthropicのモデル一覧取得エンドポイントは以下の通りである。

* **エンドポイントURL:** https://api.anthropic.com/v1/models 7  
* **HTTPメソッド:** GET  
* **認証方式:** x-api-key ヘッダー 7。

**必須ヘッダーの制約:** AnthropicのAPIにおいて最も特徴的なのは、anthropic-version ヘッダーの強制である。リクエストには必ずAPIバージョン（例: 2023-06-01）を指定しなければならない 7。このヘッダーが欠落している場合、リクエストは 400 Bad Request で拒否されるか、予期しないデフォルト動作を引き起こす可能性がある。これは、将来的なAPIの破壊的変更からクライアントを保護するための強力な契約（Contract）である。

### **3.2 ページネーションとカーソルベース設計**

OpenAIとは異なり、Anthropicのモデル一覧エンドポイントはページネーション（ページ送り）をサポートしている。

**クエリパラメータ:** 8

* **limit (integer):** 1ページあたりに取得するモデル数。デフォルトは20、最大は1000。  
* **before_id / after_id (string):** カーソルとして機能するモデルID。

**アーキテクチャ上の洞察:**

現時点でのAnthropicの基盤モデル数（Claude 3 Opus, Sonnet, Haikuなど）はそれほど多くないため、ページネーションは不要に見えるかもしれない。しかし、この設計は「ファインチューニングモデル」や「組織固有のカスタムモデル」が数百、数千に増大する将来を見越したものである。また、オフセットベース（page=2）ではなくカーソルベース（after_id=...）のページネーションを採用している点は技術的に評価できる。これにより、リスト取得中に新しいモデルが追加・削除された場合でも、データの重複や欠落（スキップ）が発生しにくく、分散システムにおける整合性が保たれやすい。

### **3.3 ベータ機能と可視性制御（Feature Gating）**

AnthropicのAPIには「ベータヘッダー（Beta Headers）」という概念が存在し、これがモデル一覧の可視性に直接影響を与える。

* **メカニズム:** 特定の先端機能（例: コンピュータ操作機能 computer-use や、超長文コンテキストキャッシュ prompt-caching）に対応したモデルや、その機能自体を利用するためには、リクエスト時に anthropic-beta ヘッダーを含める必要がある 8。  
* **一覧取得への影響:** GET /v1/models を呼び出す際、適切なベータヘッダーを付与しないと、ベータ版のモデルがリストに現れない、あるいはそのモデルの特定の機能情報が隠蔽される可能性がある。例えば、computer-use-2024-10-22 というヘッダーを付与して初めて、その機能をサポートする特定のモデルバージョンが利用可能（または可視化）になる場合がある 8。

開発者は、単にエンドポイントを叩くだけでなく、「自分がどの機能セット（ベータ機能）を有効化したいか」を明示的に宣言しながら一覧を取得する必要がある。これは、安定版ユーザーの環境を汚染することなく、先端機能のアジャイルなデプロイを可能にする高度なAPI設計である。

### **3.4 レスポンススキーマの詳細**

Anthropicのレスポンスには、OpenAIよりも人間可読性の高い情報が含まれている。

**レスポンス構造例:** 8

```json
{  
  "data":,  
  "has_more": false,  
  "first_id": "claude-3-5-sonnet-20240620",  
  "last_id": "claude-3-haiku-20240307"  
}
```

* **display_name:** UIでの表示に適した人間可読な名前（例: "Claude 3.5 Sonnet"）。これにより、フロントエンド側で claude-3-5-sonnet-20240620 を Claude 3.5 Sonnet に変換するマッピングロジックを書く手間が省ける 8。  
* **created_at:** RFC 3339形式（ISO 8601準拠）の日時文字列。Unixタイムスタンプよりも可読性が高く、標準ライブラリでのパースが容易である 8。

---

**4. Google: 二重化されたエコシステムの迷宮**

GoogleのLLMエコシステムを理解する上で最大の障壁となるのが、「Google AI Studio (Gemini API)」と「Vertex AI」という2つの異なるプラットフォームの存在である。これらは提供するモデル（Geminiなど）は共通しているが、APIのエンドポイント、認証、そして返却されるメタデータの構造は完全に別物である。開発者はまず、自分がどちらのエコシステムを利用しているかを明確に区別しなければならない。

### **4.1 Google AI Studio (Gemini API): 開発者体験の最適化**

Google AI Studio経由で提供されるGemini APIは、OpenAIのAPIに対抗するために設計された、開発者フレンドリーなREST APIである。

* **エンドポイントURL:** https://generativelanguage.googleapis.com/v1beta/models 10  
  * 安定版として v1/models も存在するが、最新機能は v1beta で提供されることが多い 10。  
* **認証:** APIキー（クエリパラメータ ?key=... またはヘッダー x-goog-api-key）。

**リッチなメタデータによる差別化:** Gemini APIのモデル一覧エンドポイントは、他社と比較して圧倒的に豊富なメタデータを提供する。これは、クライアントアプリケーションがモデルの能力を「推測」するのではなく、「知る」ことを可能にする 10。

**主なメタデータフィールド:** 10

* **inputTokenLimit & outputTokenLimit:** 入力および出力の最大トークン数が整数値で明示される。  
* **supportedGenerationMethods:** モデルがサポートするメソッドのリスト（例: generateContent, countTokens, createCachedContent）。これにより、そのモデルがチャット用なのか、埋め込み（Embedding）用なのかをプログラムで判別できる。  
* **temperature, topP, topK:** そのモデルのサンプリングパラメータのデフォルト値や最大値。

**戦略的価値:**

この詳細なメタデータにより、開発者は「入力プロンプトの長さが3万トークンを超えたら、inputTokenLimit がそれを上回るモデルをリストから自動選択する」といったロジックを実装できる。これは、将来的にモデルのスペックが向上した際にもコードを変更することなく対応できる堅牢なアプリケーションの構築を可能にする。

### **4.2 Vertex AI: Google Cloudの流儀とリソース階層**

Vertex AIは、Google Cloud Platform (GCP) の一部として提供されるエンタープライズ向けの機械学習プラットフォームである。ここでの「モデル」の概念はより複雑で、**Publisher Model（基盤モデル）** と **Model（ユーザーモデル）** に厳密に区別される。

#### **4.2.1 基盤モデルの探索 (Publisher Models)**

Googleが提供するGeminiやImagen、あるいはパートナー（Anthropic等）のモデルを探す場合、通常のエンドポイントではなく「Publisher（パブリッシャー）」リソースを叩く必要がある。

* **エンドポイント構造:** https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/{publisher}/models 13  
* **変数の意味:**  
  * {location}: リージョン（例: us-central1）または global。  
  * {publisher}: google（Gemini等）または anthropic（Claude等）。

**Model Gardenの概念:** Vertex AIでは、これらの基盤モデル群を「Model Garden」と呼ぶ。API経由で取得できるリストは、このModel Garden内のカタログ情報である。Vertex AIのリスト取得APIは、フィルタリング機能が強力であり、特定のパブリッシャーやカテゴリで絞り込むことが可能である 14。

#### **4.2.2 ユーザーモデルの探索 (Projects.Locations.Models)**

一方で、単に projects.locations.models.list というエンドポイントを叩くと、期待外れの結果（空のリストなど）が返ってくることが多い 15。

* **エンドポイント:** https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/models 16  
* **目的:** これはユーザーがAutoMLでトレーニングしたモデルや、外部からインポートしてデプロイしたカスタムモデルをリストするためのものである。  
* **落とし穴:** 多くの開発者が「モデル一覧」と聞いてこのエンドポイントを叩き、Geminiが含まれていないことに混乱する。Vertex AIにおいて、Geminiは「ユーザーが所有するモデル」ではなく「Googleが提供するサービス（Publisher Model）」であるため、ここには表示されない。

#### **4.2.3 リージョンとグローバルエンドポイント**

Vertex AIの最大の特徴（かつ複雑な点）はリージョン制約である。

* **Globalエンドポイント:** locations/global を指定すると、全リージョンで利用可能なモデルのカタログ情報が返る 13。  
* **Regionalエンドポイント:** locations/us-central1 などを指定すると、その特定のリージョンで利用可能なモデルのみが返る。データレジデンシー要件（データを特定地域から出したくない場合）がある場合、必ず特定のリージョンのエンドポイントを使用して、そのリージョンで対象モデルが利用可能かを確認しなければならない。

---

**5. 比較アーキテクチャ分析と決定マトリクス**

各プロバイダーの仕様を横断的に比較し、それぞれの設計意図とトレードオフを整理する。

### **5.1 技術仕様の比較表**

以下の表は、各社のモデル一覧取得APIの技術的な差異をまとめたものである。

| 比較項目 | OpenAI | Anthropic | Google (Gemini API) | Google (Vertex AI) |
| :--- | :--- | :--- | :--- | :--- |
| **主要エンドポイント** | `/v1/models` | `/v1/models` | `/v1beta/models` | `.../publishers/google/models` |
| **認証方式** | Bearer Token | `x-api-key` + `version` | API Key (Query/Header) | OAuth2 / IAM (ADC) |
| **ページネーション** | ❌ なし (全件取得) | ✅ あり (カーソル) | ✅ あり (PageToken) | ✅ あり (PageToken) |
| **地理的スコープ** | グローバル | グローバル | グローバル | リージョナル / グローバル |
| **メタデータ: コンテキスト長** | ❌ なし | ❌ なし | ✅ あり (Input/Output) | ✅ あり (Viewによる) |
| **メタデータ: モダリティ** | ❌ なし | ❌ なし | ✅ あり (GenerationMethods) | ✅ あり (Dedicated fields) |
| **他社モデルの包含** | ❌ なし (自社+FTのみ) | ❌ なし | ❌ なし | ✅ あり (Anthropic, Meta等) |

### **5.2 アーキテクチャ上の洞察**

1. **OpenAI**は「使いやすさ（Low Friction）」を最優先している。ドキュメントを読まなくても GET /models を叩けばJSONが返ってくるという体験は、プロトタイピングの速度を最大化する。しかし、システムが大規模化し、厳密な型定義や制約管理が必要になると、メタデータの欠如がボトルネックとなる。  
2. **Anthropic**は「安全性と拡張性（Safety & Scale）」を志向している。必須のバージョンヘッダーは、APIの挙動が変わってもクライアントが壊れないことを保証する。ページネーションの標準装備は、将来的に企業が何千ものカスタムモデルを持つ未来を想定している。  
3. **Google (Gemini API)**は「自動化（Automation）」を志向している。プログラムがモデルのスペックを自己反映（Introspection）できるため、最も高度な動的システムの構築が可能である。  
4. **Google (Vertex AI)**は「ガバナンス（Governance）」を志向している。IAMによる厳密なアクセス制御、リージョンごとの利用可能性管理、サードパーティモデル（Claude等）の統合管理など、企業のIT部門が必要とする管理機能がAPI構造に反映されている。

---

**6. 実装パターンとベストプラクティス**

これらのエンドポイントを実際のアプリケーションに統合する際の、実践的な戦略とコードレベルの配慮事項を詳述する。

### **6.1 キャッシング戦略とTTL**

モデルのラインナップは頻繁に変更されるものではない。したがって、ユーザーがページを開くたびにAPIを叩く実装は非効率であり、レート制限やレイテンシの観点から推奨されない。

* **推奨戦略:** サーバーサイド（またはエッジ）でのキャッシュ。  
* **TTL (有効期限):** 1時間〜24時間が適切。  
* **更新トリガー:** アプリケーションのデプロイ時、または管理者が手動で「モデルリスト更新」ボタンを押した際にキャッシュを無効化するロジックを組むのが理想的である。

### **6.2 404エラーとDeprecation（廃止）への自動対応**

モデル一覧APIを活用する最大のメリットは、廃止されたモデルへのリクエストを未然に防ぐことである。

**実装パターン:**

1. アプリ起動時に GET /models を実行し、有効なモデルIDのセット（Set）をメモリ上に構築する。  
2. ユーザー設定やデータベースに保存された「前回使用したモデルID」が、このセットに含まれているか検証する。  
3. 含まれていない場合（＝モデルが廃止された、または権限が剥奪された）、自動的に「推奨される代替モデル（例: 最新のエイリアス）」にフォールバックするロジックを実装する。  
4. これにより、model_not_found エラーでユーザータスクが中断することを防ぐことができる。

### **6.3 セキュリティとIAM権限 (Vertex AI特有)**

Vertex AIを利用する場合、認証には通常Google Cloudのサービスアカウントを使用する。ここで陥りやすい罠が権限設定である。

* **推論権限:** aiplatform.endpoints.predict  
* **一覧取得権限:** aiplatform.models.list  
  これらは別の権限である。推論だけを行うサービスアカウントに一覧取得権限が付与されていない場合、推論は成功するがモデル一覧取得は 403 Forbidden となる。開発環境と本番環境でIAMロールを厳密に管理する必要がある。

### **6.4 「アダプターパターン」による正規化**

マルチプロバイダー対応のアプリを作る場合、各社から返ってくるバラバラのJSONを、アプリ統一の内部フォーマットに変換する「アダプター」層が必要になる。

**推奨される内部データ構造:**

```typescript
interface UnifiedModelInfo {  
  provider: 'openai' | 'anthropic' | 'google';  
  id: string;          // APIに投げる実ID (例: gpt-4-0613)  
  displayName: string; // UI表示用 (例: GPT-4)  
  contextWindow: number; // GoogleはAPIから取得、他は辞書ファイルから補完  
  isMultimodal: boolean; // GoogleはAPIから判定、他は辞書ファイルから補完  
}
```

Google以外のプロバイダーについては、APIレスポンスと手動管理の辞書（Static Registry）をマージ（Merge）してこの構造体を生成するのが現実解である。

---

**7. 将来の展望：エージェントによる自己発見**

将来的には、MCP（Model Context Protocol）のような標準化プロトコルが進展し、AIエージェント自身が「私は今、どのモデルを使えるか？」「このタスクにはどのモデルが最適か？」をAPIを通じて自律的に交渉（Negotiation）する時代が来ると予想される。

GoogleのGemini APIが提供するような詳細なメタデータ（コンテキスト長や機能サポート）は、そのような自律的エージェントにとって不可欠な情報となる。OpenAIやAnthropicも、将来的には同様の「Capability Discovery（能力発見）」エンドポイントを拡充していく圧力を受けることになるだろう。

## **結論**

OpenAI、Anthropic、Googleはいずれも、モデル一覧を返すAPIエンドポイントを提供している。しかし、それは単なる「リスト」ではなく、各社のアーキテクチャ思想—シンプルさ、堅牢性、自動化、ガバナンス—が色濃く反映されたインターフェースである。

開発者は「エンドポイントがあるか？」という問いの先にある、「そのエンドポイントから得られる情報をどう活用して、モデルの廃止や進化に耐えうるレジリエントなシステムを構築するか」という設計課題に取り組む必要がある。本レポートで解説した各社の仕様差と実装戦略は、そのための確固たる羅針盤となるはずである。

#### **引用文献**

1. Completions | OpenAI API Reference, 2月 8, 2026にアクセス、 [https://platform.openai.com/docs/api-reference/completions](https://platform.openai.com/docs/api-reference/completions)  
2. Use your LM Studio Models in Claude Code, 2月 8, 2026にアクセス、 [https://lmstudio.ai/blog/claudecode](https://lmstudio.ai/blog/claudecode)  
3. API Rate Limits | Configure Usage Limits in OpenRouter, 2月 8, 2026にアクセス、 [https://openrouter.ai/docs/api/reference/limits](https://openrouter.ai/docs/api/reference/limits)  
4. Models | OpenAI API Reference - OpenAI Platform, 2月 8, 2026にアクセス、 [https://platform.openai.com/docs/api-reference/models/list](https://platform.openai.com/docs/api-reference/models/list)  
5. API Reference - OpenAI Platform, 2月 8, 2026にアクセス、 [https://platform.openai.com/docs/api-reference/introduction](https://platform.openai.com/docs/api-reference/introduction)  
6. Add a token limit attribute on api.openai.com/v1/models - API - OpenAI Developer Community, 2月 8, 2026にアクセス、 [https://community.openai.com/t/add-a-token-limit-attribute-on-api-openai-com-v1-models/264416](https://community.openai.com/t/add-a-token-limit-attribute-on-api-openai-com-v1-models/264416)  
7. API Overview - Claude API Docs - Claude Console, 2月 8, 2026にアクセス、 [https://platform.claude.com/docs/en/api/overview](https://platform.claude.com/docs/en/api/overview)  
8. List Models - Claude API Reference, 2月 8, 2026にアクセス、 [https://platform.claude.com/docs/en/api/models/list](https://platform.claude.com/docs/en/api/models/list)  
9. List Models - Claude API Reference, 2月 8, 2026にアクセス、 [https://platform.claude.com/docs/en/api/java/beta/models/list](https://platform.claude.com/docs/en/api/java/beta/models/list)  
10. Models | Gemini API | Google AI for Developers, 2月 8, 2026にアクセス、 [https://ai.google.dev/api/models](https://ai.google.dev/api/models)  
11. Learn about supported models | Firebase AI Logic - Google, 2月 8, 2026にアクセス、 [https://firebase.google.com/docs/ai-logic/models](https://firebase.google.com/docs/ai-logic/models)  
12. API versions explained | Gemini API | Google AI for Developers, 2月 8, 2026にアクセス、 [https://ai.google.dev/gemini-api/docs/api-versions](https://ai.google.dev/gemini-api/docs/api-versions)  
13. Deployments and endpoints | Generative AI on Vertex AI - Google Cloud Documentation, 2月 8, 2026にアクセス、 [https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations)  
14. Method: models.list | Vertex AI | Google Cloud Documentation, 2月 8, 2026にアクセス、 [https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1beta1/publishers.models/list](https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1beta1/publishers.models/list)  
15. Vertex AI `gcloud ai models list` returns "Listed 0 items" on a fully activated project, 2月 8, 2026にアクセス、 [https://stackoverflow.com/questions/79723710/vertex-ai-gcloud-ai-models-list-returns-listed-0-items-on-a-fully-activated](https://stackoverflow.com/questions/79723710/vertex-ai-gcloud-ai-models-list-returns-listed-0-items-on-a-fully-activated)  
16. Method: models.list | Vertex AI - Google Cloud Documentation, 2月 8, 2026にアクセス、 [https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1/projects.locations.models/list](https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1/projects.locations.models/list)
