import { vscriptsApi, vscriptsEnums } from "./dota-data";
import type { DeclarationsContextType } from "../components/api/Docs/DeclarationsContext";

export const vscriptsScope: DeclarationsContextType = {
  root: "/vscripts",
  declarations: [...vscriptsApi, ...vscriptsEnums]
    .map((declaration) => ({ ...declaration, isStarred: false }))
    .sort((a, b) => a.name.localeCompare(b.name)),
};
