-- 0092_mailbot_labels.sql — 信箱管家認得觀主的保留期限標籤＋起始規則
--
-- 一、mailbot_rules.label：規則除了刪／報／留，還能指定貼哪個標籤（三月/帳單繳費、五年/產品營運…）
--     mailbot_seen.label：這封實際被貼了什麼，週報與日後查帳用
-- 二、明確授權：Supabase 自 2026-10-30 起，public 底下新建的表不再自動授權給 API 角色。
--     0091 若在那之後才上，mail-butler（走 service_role）會讀寫不到這兩張表——這裡補明。冪等，早上晚上都無害。
-- 三、起始規則：2026-10-19 從觀主信箱實際抽樣出來的寄件人。之後在 TG 按出來的規則會疊上去。
--     銀行的「廣告」網域與「交易通知」網域是分開的（inedm／edm／mx1.edm／msg 是廣告），
--     這裡只刪廣告網域，交易通知留給 AI 判斷並貼三月標籤。

alter table mailbot_rules add column if not exists label text;
alter table mailbot_seen  add column if not exists label text;

grant select, insert, update, delete on mailbot_rules, mailbot_seen to service_role;
grant usage, select on sequence mailbot_rules_id_seq, mailbot_seen_id_seq to service_role;

insert into mailbot_rules (kind, pattern, action, label, note) values
  -- 產品營運憑證：一律回報並歸檔五年
  ('sender', 'invoice+statements@mail.anthropic.com', 'report', '五年/產品營運', '起始規則：Anthropic API 收據'),
  ('domain', 'notify.cloudflare.com',                 'report', '五年/產品營運', '起始規則：Cloudflare 網域與帳單'),
  -- 銀行與保險的廣告網域
  ('domain', 'inedm.ctbcbank.com',            'trash', null, '起始規則：中信廣告'),
  ('domain', 'edm.linebank.com.tw',           'trash', null, '起始規則：LINE Bank 廣告'),
  ('domain', 'mx1.edm.sinopac.com',           'trash', null, '起始規則：永豐廣告'),
  ('domain', 'news.mybank.com.tw',            'trash', null, '起始規則：國泰廣告'),
  ('domain', 'msg.esunbank.com',              'trash', null, '起始規則：玉山廣告'),
  ('domain', 'mhurcv.taishinbank.com.tw',     'trash', null, '起始規則：台新廣告'),
  ('domain', 'mailhunter.cathaylife.com.tw',  'trash', null, '起始規則：國泰人壽廣告'),
  -- 電商、旅遊、素材站電子報
  ('domain', 'newsletter.shopee.tw',          'trash', null, '起始規則：蝦皮電子報'),
  ('sender', 'stats.spx@shopee.com',          'trash', null, '起始規則：蝦皮物流統計'),
  ('domain', 'newsletter.trip.com',           'trash', null, '起始規則：Trip.com'),
  ('domain', 'e.starlux-airlines.com',        'trash', null, '起始規則：星宇行銷'),
  ('domain', 'emktng.shutterstock.com',       'trash', null, '起始規則：Shutterstock 行銷'),
  ('domain', 'emktng.turbosquid.com',         'trash', null, '起始規則：TurboSquid 行銷'),
  ('domain', 'discover.pinterest.com',        'trash', null, '起始規則：Pinterest 推薦'),
  ('domain', 'update.pinkoi.com',             'trash', null, '起始規則：Pinkoi'),
  ('domain', 'ms1.104.com.tw',                'trash', null, '起始規則：104 電子報'),
  ('domain', 'shoplinesender.com',            'trash', null, '起始規則：Shopline 商店電子報'),
  ('domain', 'em1.cloudflare.com',            'trash', null, '起始規則：Cloudflare 行銷（帳單走 notify.cloudflare.com）'),
  -- LinkedIn 推薦與通知（真人私訊 messages-noreply 不在此列，交給 AI）
  ('sender', 'jobs-listings@linkedin.com',        'trash', null, '起始規則：LinkedIn 職缺推薦'),
  ('sender', 'jobalerts-noreply@linkedin.com',    'trash', null, '起始規則：LinkedIn 職缺通知'),
  ('sender', 'notifications-noreply@linkedin.com','trash', null, '起始規則：LinkedIn 動態通知')
on conflict (kind, pattern) do nothing;
