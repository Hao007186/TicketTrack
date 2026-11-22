const MIN_PASSWORD = 8;

/** 檢查新密碼與確認欄位；通過回傳 null，否則回傳要顯示的中文錯誤。 */
export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return `密碼至少 ${MIN_PASSWORD} 個字`;
  if (password !== confirm) return "兩次輸入的密碼不一樣";
  return null;
}
