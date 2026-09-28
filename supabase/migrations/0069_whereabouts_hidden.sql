-- 0069_whereabouts_hidden.sql — 三人在觀裡隨機走動；各有一處少去的地方是隱藏支線
--
-- 【位置怎麼決定】（程式在 _shared/whereabouts.ts）
--   每兩小時一格（台北時間 0–2、2–4…），每格依權重抽一個「在哪、做什麼」。
--   種子＝使用者＋角色＋日期＋時格，所以同一格內怎麼刷新都一樣，換一格才換地方；
--   不同的人看到的不一樣（你的師兄在廊下，別人的師兄可能在大殿）。
--   一般的行程寫在程式裡；這張表只放「少去的那一處」——要改信、改機率、改觸發詞，改這裡就好。
--
-- 【怎麼算找到】
--   他此刻正在那一處，而你跟他說話時問到了那件事（ask_re 命中你那句話）。
--   兩個條件由伺服器判：位置是伺服器抽的，前端說他在哪不算數。
--   找到就寄一封他的信，夾靈石；每人每條只一次（hidden_found 的主鍵）。

create table if not exists hidden_quests (
  id            text primary key check (id ~ '^[a-z0-9_]+$'),
  character_id  text not null references characters(id),
  place         text not null,              -- 場景 key（scene/<place>），與 whereabouts.ts 的 PLACES 同一組
  doing         text not null,              -- 觀堂那行的字，例：「在灶房」
  bands         text not null,              -- 哪些時段可能出現：n 深夜 d 清晨 m 上午 z 午間 a 午後 e 傍晚 l 夜
  weight        real not null default 1.2,  -- 同一格裡與其他行程比的權重。一般行程多在 2–5，1.2 約是一成左右
  hint          text not null,              -- 在那裡時，角色知道自己在做什麼（進談心的提示詞）
  found_hint    text,                       -- 已經被撞見過之後再遇到，換這一句；空白＝照用 hint
  ask_re        text not null,              -- 你那句話命中這個（JS 正則，不分大小寫）才算問到
  mail_subject  text not null,
  mail_body     text not null,
  lingshi       int  not null default 8 check (lingshi between 0 and 1000),
  active        boolean not null default true
);

comment on table hidden_quests is
  '隱藏支線：每個角色一處少去的地方。他在那裡時問到那件事＝找到，寄信夾靈石。改內容改這張表。';

create table if not exists hidden_found (
  user_id   uuid not null references profiles(id) on delete cascade,
  quest_id  text not null references hidden_quests(id) on delete cascade,
  found_at  timestamptz not null default now(),
  mail_id   uuid,
  primary key (user_id, quest_id)
);

comment on table hidden_found is '誰找到了哪一條隱藏支線。主鍵擋第二次——不是先查再寫。';

alter table hidden_quests enable row level security;
alter table hidden_found  enable row level security;

-- 找到：先寫 hidden_found，寫得進去（第一次）才寄信。兩支請求同時進來只有一支寫得進去。
create or replace function hidden_quest_claim(p_user uuid, p_quest text)
returns jsonb
language plpgsql
security definer
as $$
declare
  q     hidden_quests%rowtype;
  v_n   int;
  v_mail uuid;
begin
  select * into q from hidden_quests where id = p_quest and active;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_quest'); end if;

  insert into hidden_found (user_id, quest_id) values (p_user, p_quest)
  on conflict (user_id, quest_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('ok', false, 'reason', 'already'); end if;

  v_mail := mail_send(p_user, q.mail_subject, q.mail_body, 'character', q.character_id,
                      'hidden_quest', null, q.lingshi);
  update hidden_found set mail_id = v_mail where user_id = p_user and quest_id = p_quest;
  return jsonb_build_object('ok', true, 'mail_id', v_mail, 'lingshi', q.lingshi);
end $$;

revoke all on function hidden_quest_claim(uuid, text) from public, anon, authenticated;
grant execute on function hidden_quest_claim(uuid, text) to service_role;

-- ── 三條支線（六六 2026-09-28）。on conflict do nothing：之後改內容請用 update 或 Table Editor。
insert into hidden_quests (id, character_id, place, doing, bands, weight, hint, found_hint, ask_re, mail_subject, mail_body, lingshi) values
(
  'm_zaofang', 'daoshi_m', 'zaofang', '在灶房', 'dzl', 1.2,
  '你一個人在灶房，照著師妹抄給你的方子蒸桂花糕。第三籠還是塌了，灶台上擺著前兩籠失敗品，袖口沾了麵粉。你不希望被人看見：被撞見時先說「路過」，被追問就不說話，最後拗不過才承認在做什麼。話照樣短，不解釋動機。',
  '你又在灶房試那份桂花糕的方子。上次已經被他撞見過，所以不再否認，只是不太想談成敗。',
  '灶|廚|蒸|煮|鍋|糕|點心|吃|焦|味道|麵粉|在做什麼|在忙什麼|做什麼',
  '灶房的事',
  E'灶房那件事，不必跟師妹說。\n\n方子是她的，火候是我看錯。第三籠塌得最少，放在你平常坐的那張案上，用紙蓋著。\n不好吃就別吃。\n\n附上幾顆靈石。不是收買。是那盞茶錢。',
  8
),
(
  'f_houyuan', 'daoshi_f', 'houyuan', '在後院', 'de', 1.2,
  '你一個人在後院，拿師兄的木劍比劃他每天早上練的那套劍招，姿勢不太對，手也酸了。被撞見時先笑著岔開、說只是活動筋骨；被追問才小聲承認想學，並拜託對方千萬別告訴師兄。',
  '你又在後院偷練那套劍招。他上次撞見過，你便不再遮掩，只是還是不想讓師兄知道。',
  '後院|劍|練|比劃|招|木樁|手酸|在做什麼|在忙什麼|做什麼',
  '別跟師兄說喔',
  E'那天在後院的事……你沒跟師兄說吧？\n\n我只是想知道，他每天早上揮那幾百下，到底在想什麼。\n結果揮了三十下手就酸了。果然不是誰都能那樣安靜。\n\n這些靈石算封口費——不對，算謝禮。謝謝你假裝沒看見。',
  8
),
(
  'c_cangjingge', 'lingshou', 'cangjingge', '在藏經閣', 'anl', 1.2,
  '你趴在藏經閣一本攤開的舊冊子上，前爪壓著其中一行，尾巴慢慢掃。被撞見就裝作只是找地方睡；被追問在看什麼，就說「字太多，壓著好睡」。絕不承認自己識字，也絕不提起「師傅」這兩個字。',
  '你又趴在藏經閣那本舊冊子上。他見過一次了，你懶得再裝，但照樣不承認在看書。',
  '藏經|書|冊|經|字|讀|看什麼|在做什麼|在忙什麼|做什麼',
  '本喵只是睡在上面',
  E'哼。\n\n那本冊子墊起來剛好，紙有太陽的味道。本喵只是睡在上面，沒有在看。\n你要是跟那兩個說本喵在藏經閣，本喵就去你枕頭上掉毛。\n\n這幾顆亮晶晶的給你。本喵用不著。拿了就閉嘴。',
  8
)
on conflict (id) do nothing;
