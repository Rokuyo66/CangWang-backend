-- 0021 收集獎勵改手動領取：集滿只算「達成」，玩家至卦曆點擊領取才算「解鎖」
-- claimed_rewards：已領取的獎勵頭像 key（r01~r13）
alter table profiles add column if not exists claimed_rewards text[] not null default '{}';

-- 回填：已裝備中的獎勵頭像視為已領取（避免上線後穿在身上的頭像反顯示未解鎖）
-- 玩家自用（selected_avatar r07~r10）
update profiles
   set claimed_rewards = claimed_rewards || array[selected_avatar]
 where selected_avatar like 'r%'
   and not (claimed_rewards @> array[selected_avatar]);

-- 御三家換裝（user_character.avatar r01~r06 / r11~r13）
update profiles p
   set claimed_rewards = p.claimed_rewards || uc.avs
  from (select user_id, array_agg(distinct avatar) as avs
          from user_character
         where avatar is not null
         group by user_id) uc
 where p.id = uc.user_id
   and not (p.claimed_rewards @> uc.avs);
