import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";

import { ApiError, errorMessage } from "../api/errors";
import {
  useAirlines,
  useAirports,
  useCreateWatch,
  usePriceReference,
  useUpdateWatch,
  useWatch,
  type Airport,
  type Watch,
} from "../api/queries";
import { PageMessage, WATCH_MISSING } from "../components/PageMessage";
import { QueryError } from "../components/QueryError";
import { buttonPrimary, buttonSecondary, card, errorBox, input, label } from "../components/ui";
import { useToast } from "../components/useToast";
import { WriteButton } from "../components/WriteButton";
import {
  CABIN_LABELS,
  formatMonthDay,
  formatPrice,
  todayInTaipei,
  type Cabin,
} from "../lib/format";
import {
  dateRange,
  emptyForm,
  fromWatch,
  referenceConditions,
  resetsAlertState,
  toCreateBody,
  toUpdateBody,
  validate,
  type FormErrors,
  type WatchFormValues,
} from "../lib/watchForm";

const QUEUED_HINT = "目前全站名額已滿，有空位時會自動開始查價";
const RESET_CONFIRM = "通知狀態會重置，之後的降價會重新判斷。確定要儲存嗎？";

const COUNTRY_NAMES: Record<string, string> = {
  JP: "日本",
  KR: "韓國",
  HK: "香港",
  MO: "澳門",
  CN: "中國",
  TH: "泰國",
  SG: "新加坡",
  MY: "馬來西亞",
  PH: "菲律賓",
  VN: "越南",
  ID: "印尼",
  KH: "柬埔寨",
  MM: "緬甸",
  GU: "關島",
  US: "美國",
  CA: "加拿大",
  GB: "英國",
  FR: "法國",
  DE: "德國",
  NL: "荷蘭",
  AT: "奧地利",
  TR: "土耳其",
  AE: "阿聯",
  AU: "澳洲",
  NZ: "紐西蘭",
};

function groupByCountry(airports: Airport[]): [string, Airport[]][] {
  const groups = new Map<string, Airport[]>();
  for (const a of airports) groups.set(a.country, [...(groups.get(a.country) ?? []), a]);
  return [...groups.entries()];
}

function Field({
  id,
  text,
  error,
  children,
}: {
  id: string;
  text: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={label}>
        {text}
      </label>
      {children}
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}

/** 目標價下方的參考價；條件不完整、載入中或查詢失敗時不顯示 */
function PriceReferenceHint({ values, editing }: { values: WatchFormValues; editing: boolean }) {
  const { data } = usePriceReference(referenceConditions(values));
  if (!data) return null;
  const { typical_low: low, typical_high: high, updated_at } = data;
  const text =
    low !== null && high !== null
      ? `同條件的典型價格：${formatPrice(low)}～${formatPrice(high)}` +
        (updated_at ? `（${formatMonthDay(updated_at)} 更新）` : "")
      : `這個行程還沒有價格資料，${editing ? "儲存" : "建立"}後第一次查價就會顯示，之後可以再調整目標價`;
  return <p className="mt-1 text-xs text-slate-500">{text}</p>;
}

function WatchForm({ original }: { original?: Watch }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: airports = [] } = useAirports();
  const { data: airlines = [] } = useAirlines();
  const create = useCreateWatch();
  const update = useUpdateWatch(original?.public_id ?? "");
  const [values, setValues] = useState<WatchFormValues>(() =>
    original ? fromWatch(original) : emptyForm(),
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const today = todayInTaipei();
  const { earliest, latest } = dateRange(today);
  // 快出發的追蹤原本的出發日可能早於 earliest，保留它才不會被日期欄位標成不合法
  const minDepart = original && original.depart_date < earliest ? original.depart_date : earliest;
  const origins = airports.filter((a) => a.is_origin);
  const destinations = groupByCountry(airports.filter((a) => !a.is_origin));
  const busy = create.isPending || update.isPending;

  function set<K extends keyof WatchFormValues>(key: K, value: WatchFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function toggleAirline(code: string) {
    set(
      "airlines",
      values.airlines.includes(code)
        ? values.airlines.filter((c) => c !== code)
        : [...values.airlines, code],
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const found = validate(values, today, original);
    setErrors(found);
    setSubmitError(null);
    if (Object.keys(found).length > 0) return;

    try {
      let saved: Watch;
      if (original) {
        const body = toUpdateBody(values, original);
        if (Object.keys(body).length === 0) {
          navigate(`/watches/${original.public_id}`);
          return;
        }
        if (resetsAlertState(body) && !window.confirm(RESET_CONFIRM)) return;
        saved = await update.mutateAsync(body);
      } else {
        saved = await create.mutateAsync(toCreateBody(values));
      }
      if (saved.status === "queued") toast.show(QUEUED_HINT);
      navigate(`/watches/${saved.public_id}`);
    } catch (err) {
      setSubmitError(errorMessage(err));
    }
  }

  return (
    <form onSubmit={onSubmit} className={`${card} space-y-5`} noValidate>
      {submitError && <p className={errorBox}>{submitError}</p>}

      <div className="grid gap-5 md:grid-cols-2">
        <Field id="origin" text="出發地" error={errors.origin}>
          <select
            id="origin"
            className={input}
            value={values.origin}
            onChange={(e) => set("origin", e.target.value)}
          >
            {origins.map((a) => (
              <option key={a.iata} value={a.iata}>
                {a.name_zh} {a.iata}
              </option>
            ))}
          </select>
        </Field>
        <Field id="destination" text="目的地" error={errors.destination}>
          <select
            id="destination"
            className={input}
            value={values.destination}
            onChange={(e) => set("destination", e.target.value)}
          >
            <option value="">請選擇</option>
            {destinations.map(([country, list]) => (
              <optgroup key={country} label={COUNTRY_NAMES[country] ?? country}>
                {list.map((a) => (
                  <option key={a.iata} value={a.iata}>
                    {a.name_zh} {a.iata}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
      </div>

      <fieldset>
        <legend className={label}>行程</legend>
        <div className="flex gap-6">
          {(["round_trip", "one_way"] as const).map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="tripType"
                checked={values.tripType === t}
                onChange={() => set("tripType", t)}
              />
              {t === "round_trip" ? "來回" : "單程"}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-5 md:grid-cols-2">
        <Field id="depart-date" text="出發日" error={errors.departDate}>
          <input
            id="depart-date"
            type="date"
            className={input}
            min={minDepart}
            max={latest}
            value={values.departDate}
            onChange={(e) => set("departDate", e.target.value)}
          />
        </Field>
        {values.tripType === "round_trip" && (
          <Field id="return-date" text="回程日" error={errors.returnDate}>
            <input
              id="return-date"
              type="date"
              className={input}
              min={values.departDate || minDepart}
              max={latest}
              value={values.returnDate}
              onChange={(e) => set("returnDate", e.target.value)}
            />
          </Field>
        )}
      </div>

      <div className="grid gap-5 md:grid-cols-3">
        <Field id="cabin" text="艙等">
          <select
            id="cabin"
            className={input}
            value={values.cabin}
            onChange={(e) => set("cabin", e.target.value as Cabin)}
          >
            {Object.entries(CABIN_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </Field>
        <Field id="adults" text="人數">
          <select
            id="adults"
            className={input}
            value={values.adults}
            onChange={(e) => set("adults", Number(e.target.value))}
          >
            {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} 人
              </option>
            ))}
          </select>
        </Field>
        <Field id="target-price" text="目標價（TWD）" error={errors.targetPrice}>
          <input
            id="target-price"
            inputMode="numeric"
            className={input}
            value={values.targetPrice}
            onChange={(e) => set("targetPrice", e.target.value)}
          />
          <PriceReferenceHint values={values} editing={original !== undefined} />
        </Field>
      </div>

      <fieldset>
        <legend className={label}>航空公司</legend>
        <p className="mb-2 text-xs text-slate-500">不勾就是全部航空公司</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-3">
          {airlines.map((a) => (
            <label key={a.iata} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values.airlines.includes(a.iata)}
                onChange={() => toggleAirline(a.iata)}
              />
              {a.name_zh}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex justify-end gap-3">
        <button type="button" className={buttonSecondary} onClick={() => navigate(-1)}>
          取消
        </button>
        <WriteButton type="submit" className={buttonPrimary} disabled={busy}>
          {original ? "儲存" : "建立追蹤"}
        </WriteButton>
      </div>
    </form>
  );
}

function EditWatch() {
  const { id = "" } = useParams();
  const { data: watch, error, refetch } = useWatch(id);
  if (error instanceof ApiError && error.status === 404)
    return <PageMessage message={WATCH_MISSING} />;
  if (error) return <QueryError error={error} onRetry={() => void refetch()} />;
  if (!watch) return <p className="text-slate-500">載入中…</p>;
  if (watch.status === "expired") {
    return (
      <PageMessage
        message="已過期的追蹤不能修改"
        backTo={`/watches/${watch.public_id}`}
        backLabel="回追蹤詳情"
      />
    );
  }
  return <WatchForm original={watch} />;
}

export function WatchFormPage({ mode }: { mode: "create" | "edit" }) {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 text-2xl font-bold">{mode === "create" ? "新增追蹤" : "編輯追蹤"}</h1>
      {mode === "create" ? <WatchForm /> : <EditWatch />}
    </div>
  );
}
