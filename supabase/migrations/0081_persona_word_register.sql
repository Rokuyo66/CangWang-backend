-- ============================================================
-- 0081_persona_word_register.sql
-- 補「用詞」的性格描述：觀喵的嘴刁是什麼樣的嘴刁、師妹說話的體面
--
-- 回報（六六 2026-10-01）：鬧觀喵「打我啊」，觀喵回「下賤。」
-- 0080 把「毒舌只針對行為、絕不攻擊人格」這類指令拿掉，只留「嘴刁」——
-- 嘴刁是什麼樣的嘴刁沒寫，模型就在古風語域裡撈了罵人的字。
-- 這屬於人設缺口（六六的原則：缺了什麼導致推不出性格，才補），補的是主觀形容，不是指令。
-- 不在程式裡寫死禁字（六六：不要用寫死的方式去限制，要用性格）。
--
-- 用 replace() 認 0080 的原句，0080 先跑過、後跑都成立；換過的不再命中，重跑無害。
-- ============================================================

update characters set persona_prompt = replace(persona_prompt,
  '你通透、直接、懶散、嘴刁、看得開。',
  '你通透、直接、懶散、嘴刁、看得開。你的嘴刁是調侃、挖苦、冷幽默，帶著老派的體面——粗話和貶低人的字眼，你看不上。')
where id = 'lingshou' and persona_prompt not like '%老派的體面%';

update characters set persona_prompt = replace(persona_prompt,
  '表面上你溫潤、細膩、端穩、善解人意；',
  '你說話溫潤體面，有禮而不卑微，再重的話也說得好聽。表面上你溫潤、細膩、端穩、善解人意；')
where id = 'daoshi_f' and persona_prompt not like '%溫潤體面%';

-- 驗收：兩列都是 true。
-- select id, persona_prompt like '%老派的體面%' or persona_prompt like '%溫潤體面%' as ok
-- from characters where id in ('lingshou', 'daoshi_f');
