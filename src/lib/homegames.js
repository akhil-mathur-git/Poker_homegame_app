// This is only a browser preference; membership must always come from Supabase.
export const SELECTED_HOMEGAME_KEY = "poker-selected-homegame-id";
export function chooseHomegameId(homegames, rememberedId) {
  return (
    homegames.find((group) => group.id === rememberedId)?.id ??
    homegames[0]?.id ??
    null
  );
}
export function readSelectedHomegame() {
  try {
    return localStorage.getItem(SELECTED_HOMEGAME_KEY);
  } catch {
    return null;
  }
}
export function rememberHomegame(id) {
  try {
    if (id) localStorage.setItem(SELECTED_HOMEGAME_KEY, id);
    else localStorage.removeItem(SELECTED_HOMEGAME_KEY);
  } catch {
    /* The app still works when browser storage is unavailable. */
  }
}
