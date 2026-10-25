import { errorMessage } from "../api/errors";
import { buttonSecondary } from "./ui";

export function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
      <p className="text-red-700">{errorMessage(error)}</p>
      <button type="button" className={`${buttonSecondary} mt-3`} onClick={onRetry}>
        重試
      </button>
    </div>
  );
}
