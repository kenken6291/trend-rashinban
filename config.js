/**
 * トレンド羅針盤 - 設定ファイル
 * GAS の URL やバージョンはここだけ書き換えれば切り替わります。
 * ※ Gemini API キーは安全のため GAS のスクリプトプロパティ側で管理します（ここには書かない）。
 */
window.APP_CONFIG = {
  APP_NAME: 'トレンド羅針盤',
  VERSION: 'v1.3.0',

  // GAS ウェブアプリの URL（デプロイ後に貼り替え）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbyI75JG3_t7mSS2sr4CWU9DuoTIyg4tHXitIPwMUVXg2IEMeV9pj7Ry2sOUZFMMSqyn2Q/exec',

  // 通信のタイムアウト（ミリ秒）。検索付きのAI生成は時間がかかるため長め
  REQUEST_TIMEOUT_MS: 150000,

  // ジャンル候補（このほかに「その他」で自由入力できます）
  GENRES: ['ドラマ', '映画', '音楽', '本', '小説', 'スポーツ', 'アウトドア', '旅行', '料理', '服', '化粧', 'ヘアスタイル', '会話ネタ', 'お笑い', '演劇'],

  // Gemini 関連（APIキーは GAS 側のスクリプトプロパティで設定）
  GEMINI: {
    TREND_ITEMS: 14,   // 1枚のマップに載せる流行アイテム数（8〜20）
    TTS_VOICE: 'Kore', // 読み上げの声（Kore / Puck / Charon / Aoede など）

    // 既定のAIモデル（画面で選ばなかった時）。'' = 自動（汎用の最新モデル）
    MODEL: '',

    // 画面の「AIモデル」選択肢（value が API のモデルID）
    // 指定モデルが使えない（廃止・未公開・名前違い）場合は GAS 側で汎用の最新モデルへ自動で切り替わります
    MODEL_OPTIONS: [
      { value: '',                  label: '自動モード（汎用の最新）' },
      { value: 'gemini-4-hydrogen', label: '4 Hydrogen（日々の暮らしをサポート）' },
      { value: 'gemini-4-neon',     label: '4 Neon（Deeper analysis）' },
      { value: 'gemini-4-carbon',   label: '4 Carbon（Code & complex work）' },
      { value: 'gemini-4-argon',    label: '4 Argon' },
      { value: 'gemini-3.8-flash',  label: '3.8 Flash' },
      { value: 'gemini-3.5-flash',  label: '3.5 Flash' }
    ]
  },

  // マップの何もない場所をタップしたとき、周辺とみなす距離（座標 -100〜100 に対して）
  NEAR_RADIUS: 30,

  // Google Earth で開くときのカメラ設定
  EARTH: {
    RANGE: 2500,  // 地点からの距離（m）
    TILT: 60      // 見下ろす角度
  }
};
