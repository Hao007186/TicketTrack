"""登入、改密碼相關的使用者提示文字。鎖定分鐘數由 service.LOCKOUT_DURATION 算出。"""

from app.modules.auth import service

LOCK = int(service.LOCKOUT_DURATION.total_seconds() // 60)

BAD_CREDENTIALS = "Email 或密碼錯誤"


def wrong_password(remaining: int) -> str:
    return f"Email 或密碼錯誤，再錯 {remaining} 次會鎖定 {LOCK} 分鐘"


def wrong_current_password(remaining: int) -> str:
    return f"目前的密碼錯誤，再錯 {remaining} 次會鎖定 {LOCK} 分鐘"


def locked(minutes: int) -> str:
    return f"登入失敗次數過多，帳號已鎖定，請約 {minutes} 分鐘後再試，或使用忘記密碼重設"
