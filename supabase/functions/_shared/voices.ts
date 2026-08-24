// _shared/voices.ts — 誰用哪一把嗓子。
//
// 為什麼是一支檔案而不是散在呼叫處：同一個角色會在解卦、閒聊、道緣事件、卦案
// 四個地方說話。聲線寫在各自的呼叫處，換一次音色就要改四個地方，而且遲早會漏掉
// 一個——玩家聽到的就是「師兄在卦案裡換了個人」。
//
// voice_id 是 MiniMax 系統音色的字串（platform.minimax.io 上試聽後複製）。
// 換音色只改這裡，其餘不動。

/** 沒有指定角色時用的嗓子——解卦批文、旁白、系統話語都走這一把。 */
export const VOICE_NARRATOR = "Chinese_gravelly_storyteller_nv1";

/** 角色 → 音色。key 對齊 characters 表的 id。 */
export const VOICE_BY_CHARACTER: Record<string, string> = {
  daoshi_m: "Chinese_bazong",                        // 師兄：低、冷、句尾收得乾淨
  daoshi_f: "Chinese (Mandarin)_IntellectualGirl",   // 師妹：亮一點、語氣有起伏
  lingshou: "Chinese_playful_streamer_nv1",          // 觀喵：偏年輕、帶點調皮
};

/** 取音色。查無此角色就退回旁白那一把——寧可用旁白的聲音念，
 *  也不要因為多了一個還沒配音的角色就整段念不出來。 */
export const voiceOf = (characterId?: string | null): string =>
  (characterId && VOICE_BY_CHARACTER[characterId]) || VOICE_NARRATOR;

/** 合成用的模型。用主控台範例上那一個——turbo 系列較便宜也較快，但我沒有
 *  證據說這個帳號開通了它，而猜錯的下場是每一次朗讀都回錯誤。
 *  要換型號設 MINIMAX_TTS_MODEL 即可，不必改程式重新部署。 */
export const TTS_MODEL = "speech-2.8-hd";
