import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";

import type { PricePoint } from "../api/queries";
import { formatDateTime, formatPrice, todayInTaipei } from "../lib/format";

const HEIGHT = 320;

function dayLabel(iso: string): string {
  // 依台灣時間取日期，顯示成 10/22
  const [, m, d] = todayInTaipei(new Date(iso)).split("-");
  return `${Number(m)}/${Number(d)}`;
}

function ChartTooltip({ active, payload }: TooltipContentProps<number, string>) {
  const point = payload?.[0]?.payload as PricePoint | undefined;
  if (!active || !point) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow">
      <p className="font-semibold">{formatPrice(point.price)}</p>
      {point.airline_iata && <p className="text-slate-600">航空公司 {point.airline_iata}</p>}
      <p className="text-slate-500">{formatDateTime(point.observed_at)} 查價</p>
    </div>
  );
}

export function PriceChart({
  points,
  targetPrice,
  typicalLow,
  typicalHigh,
}: {
  points: PricePoint[];
  targetPrice: number;
  typicalLow: number | null;
  typicalHigh: number | null;
}) {
  if (points.length === 0) {
    return (
      <div
        className="grid place-items-center rounded-lg bg-slate-50 text-slate-500"
        style={{ height: HEIGHT }}
      >
        每天查價一次，第一筆價格出來後就會顯示
      </div>
    );
  }

  // Y 軸要包含目標價和典型區間，否則參考線會畫在圖外
  const values = [...points.map((p) => p.price), targetPrice];
  if (typicalLow !== null) values.push(typicalLow);
  if (typicalHigh !== null) values.push(typicalHigh);
  const min = Math.floor((Math.min(...values) * 0.95) / 100) * 100;
  const max = Math.ceil((Math.max(...values) * 1.05) / 100) * 100;

  return (
    <ResponsiveContainer
      width="100%"
      height={HEIGHT}
      initialDimension={{ width: 800, height: HEIGHT }}
    >
      <LineChart data={points} margin={{ top: 10, right: 20, bottom: 0, left: 10 }}>
        <CartesianGrid stroke="#e2e8f0" vertical={false} />
        {typicalLow !== null && typicalHigh !== null && (
          <ReferenceArea y1={typicalLow} y2={typicalHigh} fill="#3b82f6" fillOpacity={0.08} />
        )}
        <ReferenceLine
          y={targetPrice}
          stroke="#16a34a"
          strokeDasharray="6 4"
          label={{ value: "目標價", position: "insideTopRight", fill: "#16a34a", fontSize: 12 }}
        />
        <XAxis dataKey="observed_at" tickFormatter={dayLabel} tick={{ fontSize: 12 }} />
        <YAxis
          domain={[min, max]}
          tickFormatter={(v: number) => formatPrice(v)}
          tick={{ fontSize: 12 }}
          width={90}
        />
        <Tooltip content={ChartTooltip} />
        <Line
          type="monotone"
          dataKey="price"
          stroke="#2563eb"
          strokeWidth={2}
          dot={{ r: 3 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
