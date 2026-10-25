import type { Airport, Watch } from "../api/queries";

export function airportLabel(code: string, airports: Airport[] | undefined): string {
  const airport = airports?.find((a) => a.iata === code);
  return airport ? `${airport.name_zh} ${code}` : code;
}

export function routeLabel(watch: Watch, airports: Airport[] | undefined): string {
  return `${airportLabel(watch.origin, airports)} → ${airportLabel(watch.destination, airports)}`;
}
