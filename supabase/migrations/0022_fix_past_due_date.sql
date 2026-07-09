-- 0022_fix_past_due_date.sql
-- 應期防呆補救：清掉「應期早於占期」的錯誤紀錄。
-- 起因：模型偶會把 due_date 回填到占期之前（過去日期），曆上因此出現往回設定的紅點。
-- 占期＝該卦 created_at 轉台北時區(UTC+8)的日期；任何 due_date < 占期 皆為無效應期，一律作廢改 null。
-- 對應程式修正：_shared/pipeline.ts 起卦時的應期防呆、_shared/rules.ts 的應期錨定硬規。

-- 1) 先清 feedback 上對應錯誤卦的應期（免到期提醒誤觸、免曆上紅點）
update feedback f
set due_date = null
from casts c
where f.cast_id = c.id
  and f.due_date is not null
  and f.due_date < (c.created_at at time zone 'Asia/Taipei')::date;

-- 2) 再清 casts 本身的錯誤應期
update casts
set due_date = null
where due_date is not null
  and due_date < (created_at at time zone 'Asia/Taipei')::date;
