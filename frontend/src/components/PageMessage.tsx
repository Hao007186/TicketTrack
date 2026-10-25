import { Link } from "react-router";

/** 整頁的提示（找不到、不能修改…），附一個返回連結。 */
export function PageMessage({
  message,
  backTo = "/watches",
  backLabel = "回我的追蹤",
}: {
  message: string;
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <div className="py-16 text-center">
      <p className="text-lg text-slate-700">{message}</p>
      <Link to={backTo} className="mt-4 inline-block text-blue-600 hover:underline">
        {backLabel}
      </Link>
    </div>
  );
}

export const WATCH_MISSING = "找不到這個追蹤，可能已被刪除";
