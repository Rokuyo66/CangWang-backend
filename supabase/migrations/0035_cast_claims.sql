-- 起卦冪等：同一次起卦動作只准成立一卦。
--
-- 先前完全沒有防重：前端連點兩下、或斷線重試、或兩台裝置同時送，
-- 就會扣兩次靈石、跑兩次 AI、寫兩筆卦（而且兩筆的用神可能還不一樣，
-- 因為用神是 AI 依卦取定的）。
--
-- 不用「查有沒有相同問句的卦」這種事後比對——第二次請求進來時第一次還沒寫完，
-- 查不到。改成請求一進來就先搶一個 token：搶得到的才做事，搶不到的直接回頭
-- 等第一份結果。主鍵本身就是併發下的仲裁者。
create table if not exists cast_claims (
  token       text primary key,
  user_id     uuid not null,
  cast_id     uuid,                       -- 完成後回填；null 表示仍在批
  created_at  timestamptz not null default now()
);

create index if not exists cast_claims_created_idx on cast_claims (created_at);

comment on table cast_claims is '起卦冪等憑據：前端每次起卦產生一個 token，同 token 只成立一卦';
