// dev/romance-test.mts — 好感分層：層級門檻與跳級偵測（誤判也要測：日常旁白不可命中）。跑法：deno run -A dev/romance-test.mts
import { romanceLevel, favorTierName, overLevel } from "../supabase/functions/_shared/chat.ts";
let ok=0, bad=0; const t=(n:string,c:boolean)=>{ c?ok++:(bad++,console.log("✗",n)); };
t("m 569 → 2", romanceLevel("daoshi_m",569)===2);
t("f 236 → 0", romanceLevel("daoshi_f",236)===0);
t("cat 402 → 0", romanceLevel("lingshou",402)===0);
t("cat 820 → 1", romanceLevel("lingshou",820)===1);
t("cat 960 → 3", romanceLevel("lingshou",960)===3);
t("tier 569 相知", favorTierName(569)==="相知");
// 誤判：日常旁白不可命中
for (const r of ["＊大師兄抱住卦書，撫過卦紙＊「坐。」","＊觀喵蜷在你腳邊，尾巴搭上你的手＊「別吵。」","「我記得你喜歡涼一點的茶。」"])
  t("no false+ lv0: "+r, !overLevel("daoshi_m",100,r));
// 相知(569) 可牽手、說捨不得；不可擁抱、我愛你
t("m569 牽手 ok", !overLevel("daoshi_m",569,"＊他牽起你的手＊「走吧。」"));
t("m569 捨不得 ok", !overLevel("daoshi_m",569,"「我捨不得你走。」"));
t("m569 擁抱 ✗", overLevel("daoshi_m",569,"＊他抱住你＊"));
t("m569 我愛你 ✗", overLevel("daoshi_m",569,"「我愛你。」"));
t("m850 吻 ok", !overLevel("daoshi_m",850,"＊他輕輕吻你的額頭＊"));
t("f236 我喜歡你 ✗", overLevel("daoshi_f",236,"「我喜歡你呀。」"));
t("cat402 靠肩 ✗", overLevel("lingshou",402,"＊牠靠在你肩上＊"));
t("cat402 捨不得 ✗", overLevel("lingshou",402,"「本喵才不是捨不得你。」"));
console.log(`${ok} 過 / ${bad} 敗`);
