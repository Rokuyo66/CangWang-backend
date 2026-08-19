// dev/play/entry.ts — 獨立版卦案原型：固定跑荒村借宿。
//
// 畫面與流程都在 dev/shared/play-ui.ts，這裡只負責指定案件檔並掛上去。
// 填表工具走同一支模組，差別只在它傳的是「當下這份草稿」。

import { HUANGCUN } from "../../supabase/functions/_shared/cases/huangcun.ts";
import { mountPlay } from "../shared/play-ui.ts";

mountPlay(document.getElementById("app")!, HUANGCUN);
