-- 0030 — 成本記錄補完整、方案欄位就位
--
-- 一、ai_usage 少記了快取 token
--    Anthropic 的 usage.input_tokens 只算「未命中快取的部分」，快取寫入與讀取
--    另有欄位。原本只記 input_tokens，等於系統性低估輸入成本——拿它算單位成本
--    會偏低，定價就會定錯。補兩欄各自記錄，才對得起「成本監控真相來源」這句話。
alter table ai_usage add column if not exists cache_write_tokens int not null default 0;
alter table ai_usage add column if not exists cache_read_tokens  int not null default 0;

-- 二、方案欄位
--    金流還沒接，但全域熔斷、免費額度、追問次數都要依方案分流；欄位先就位，
--    付費用戶才不會被為免費用戶設的天花板卡死。plan_until 為 null 表示無期限
--    （或未訂閱）；到期判斷一律看 plan_until，不另存狀態，免得兩份真相打架。
alter table profiles add column if not exists plan       text not null default 'free';
alter table profiles add column if not exists plan_until timestamptz;

comment on column profiles.plan is 'free | guanwei | zhiji | cangwang；到期看 plan_until';
