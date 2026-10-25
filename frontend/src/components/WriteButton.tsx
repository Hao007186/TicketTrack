import { useId, type ButtonHTMLAttributes } from "react";

import { useAuth } from "../auth/context";

const DEMO_HINT = "示範帳號無法修改";

/** 寫入操作的按鈕：示範帳號時不能按，並說明原因（後端也會擋，這裡是讓訪客看得懂）。 */
export function WriteButton({ disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { isDemo } = useAuth();
  const hintId = useId();
  if (!isDemo) return <button type="button" disabled={disabled} {...props} />;
  return (
    <>
      <button type="button" {...props} disabled title={DEMO_HINT} aria-describedby={hintId} />
      <span id={hintId} className="sr-only">
        {DEMO_HINT}
      </span>
    </>
  );
}
