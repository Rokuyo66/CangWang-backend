// _shared/cases/index.ts — 可上線的案件清冊。
//
// 有這一支，是因為「哪些案子玩得到」是伺服器的決定，不是前端的。
// 前端送上來的 case_id 只是一個字串，若沒有一份白名單去對，任何字串都會一路
// 走到 projectCase()——查無此案時的行為由當場的 undefined 決定，而不是由這裡決定。
//
// 新增案件只改這裡：寫好 cases/<id>.ts，import 進來，加進 CASES。
// 檔名不當 id 用（id 寫在 CaseFile 裡），下面的自檢會擋掉兩者對不上的情況。

import type { CaseFile } from "../case-schema.ts";
import { HUANGCUN } from "./huangcun.ts";

const ALL: CaseFile[] = [HUANGCUN];

for (const cf of ALL) {
  // 鍵與 CaseFile.id 對不上，存檔就會用一個查不回案件檔的 case_id 寫進 case_runs，
  // 而那份存檔再也重建不出來。寧可部署時就炸。
  if (!cf.id) throw new Error("案件檔缺 id");
}

export const CASES: Record<string, CaseFile> = Object.fromEntries(ALL.map((cf) => [cf.id, cf]));

/** 查案件檔。查無此案回 null——呼叫端一律要處理，別用 ! 硬過。 */
export const caseOf = (id: unknown): CaseFile | null => CASES[String(id ?? "")] ?? null;

/** 進案前給玩家看的清單。不含 truth／brief／clues／npcs——那些是案件內容，
 *  在選單階段就下發等於把案子劇透完。 */
export function caseMenu() {
  return ALL.map((cf) => ({
    id: cf.id,
    title: cf.title,
    question: cf.question,
    entry_hour: cf.entryHour,
    regions: cf.regions.length,
  }));
}
