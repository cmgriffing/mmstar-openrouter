/**
 * Quadrant chart for the comparison island.
 *
 * Hand-rolled SVG with zero charting dependencies: one point per plottable
 * evaluation, median crosshairs, keyboard-focusable points, and a hover/focus
 * tooltip that renders unknown values as "not reported". Cost axes default to
 * a log10 scale. The component holds only the active tooltip; selection, axes,
 * and scale are owned by `ComparisonExplorer`.
 */
import { useState } from "react";
import { formatCount, formatPercent } from "../lib/format";
import type {
  ChartAxisBounds,
  ChartExclusion,
  ComparisonChartPoint,
  ComparisonMetric,
  CostScale,
} from "../lib/view";
import {
  buildChartAxisScale,
  COMPARISON_METRIC_OPTIONS,
  chartEmptyMessage,
  chartExclusionText,
  median,
  metricDirectionLabel,
  metricLabel,
  metricValueLabel,
} from "../lib/view";

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 420;
const MARGIN = { top: 20, right: 20, bottom: 46, left: 70 };
const PLOT_WIDTH = VIEW_WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = VIEW_HEIGHT - MARGIN.top - MARGIN.bottom;
const POINT_RADIUS = 5;

export interface QuadrantChartProps {
  points: ComparisonChartPoint[];
  excluded: ChartExclusion[];
  x: ComparisonMetric;
  y: ComparisonMetric;
  costScale: CostScale;
  onAxisChange(axis: "x" | "y", metric: ComparisonMetric): void;
  onCostScaleChange(scale: CostScale): void;
}

/** Stable string hash so colors never move between renders. */
function stableHash(value: string): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return hash >>> 0;
}

function modelColor(alias: string): string {
  const hue = (stableHash(alias) * 47) % 360;
  return `hsl(${hue} 52% 34%)`;
}

function coverageLabel(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "not reported" : formatPercent(value);
}

function tickLabel(metric: ComparisonMetric, value: number): string {
  if (metric === "pass") return formatPercent(value, 0);
  return metricValueLabel(metric, value);
}

/** Metrics with a natural floor (and ceiling, for pass rate) never pad past them. */
function axisBounds(metric: ComparisonMetric): ChartAxisBounds {
  return metric === "pass" ? { min: 0, max: 1 } : { min: 0 };
}

function pointAriaLabel(point: ComparisonChartPoint) {
  return [
    `${point.modelAlias}, reasoning mode ${point.reasoningMode}`,
    `${metricLabel("cost")} ${metricValueLabel("cost", point.metrics.cost)}`,
    `${metricLabel("speed")} ${metricValueLabel("speed", point.metrics.speed)}`,
    `${metricLabel("tokens")} ${metricValueLabel("tokens", point.metrics.tokens)}`,
    `${metricLabel("pass")} ${metricValueLabel("pass", point.metrics.pass)}`,
    `coverage ${coverageLabel(point.coverage)}`,
    `attempts ${formatCount(point.attempts)}`,
  ].join(". ");
}

function TooltipRow(props: { label: string; value: string }) {
  return (
    <div className="chart-tooltip-row">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

export default function QuadrantChart(props: QuadrantChartProps) {
  const { points, excluded, x, y, costScale, onAxisChange, onCostScaleChange } = props;
  const [activePoint, setActivePoint] = useState<ComparisonChartPoint | null>(null);

  const costOnAxis = x === "cost" || y === "cost";
  const xScale = buildChartAxisScale(
    points.map((point) => point.x),
    x === "cost" && costScale === "log",
    axisBounds(x),
  );
  const yScale = buildChartAxisScale(
    points.map((point) => point.y),
    y === "cost" && costScale === "log",
    axisBounds(y),
  );

  const screenX = (value: number): number =>
    MARGIN.left + (xScale?.position(value) ?? 0) * PLOT_WIDTH;
  const screenY = (value: number): number =>
    MARGIN.top + (1 - (yScale?.position(value) ?? 0)) * PLOT_HEIGHT;

  const medianX = points.length >= 2 ? median(points.map((point) => point.x)) : null;
  const medianY = points.length >= 2 ? median(points.map((point) => point.y)) : null;

  const emptyMessage = chartEmptyMessage(excluded);

  return (
    <figure className="chart-figure">
      <div className="chart-controls">
        <div className="field">
          <label htmlFor="chart-axis-x">X axis</label>
          <select
            id="chart-axis-x"
            value={x}
            onChange={(event) => onAxisChange("x", event.target.value as ComparisonMetric)}
          >
            {COMPARISON_METRIC_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="chart-axis-y">Y axis</label>
          <select
            id="chart-axis-y"
            value={y}
            onChange={(event) => onAxisChange("y", event.target.value as ComparisonMetric)}
          >
            {COMPARISON_METRIC_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {costOnAxis && (
          <div className="field">
            <span className="field-label" id="chart-scale-label">
              Cost scale
            </span>
            <fieldset className="chart-scale" aria-labelledby="chart-scale-label">
              <button
                type="button"
                className={`button button--quiet${costScale === "log" ? " is-active" : ""}`}
                aria-pressed={costScale === "log"}
                onClick={() => onCostScaleChange("log")}
              >
                Log
              </button>
              <button
                type="button"
                className={`button button--quiet${costScale === "linear" ? " is-active" : ""}`}
                aria-pressed={costScale === "linear"}
                onClick={() => onCostScaleChange("linear")}
              >
                Linear
              </button>
            </fieldset>
          </div>
        )}
      </div>

      {points.length === 0 || xScale === null || yScale === null ? (
        <div className="empty-panel chart-empty">
          <h3>Nothing plottable</h3>
          <p>{emptyMessage}</p>
        </div>
      ) : (
        <div className="chart-canvas">
          <svg
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            role="img"
            aria-label={`Scatter plot of ${points.length} selected evaluation${
              points.length === 1 ? "" : "s"
            }: ${metricLabel(x)} (${metricDirectionLabel(x)}) on the x axis, ${metricLabel(y)} (${metricDirectionLabel(y)}) on the y axis. Values are listed in the comparison table.`}
          >
            <rect
              className="chart-plot"
              x={MARGIN.left}
              y={MARGIN.top}
              width={PLOT_WIDTH}
              height={PLOT_HEIGHT}
            />

            {xScale.ticks.map((tick) => (
              <g className="chart-tick" key={`x-${tick.value}`}>
                <line
                  x1={MARGIN.left + tick.position * PLOT_WIDTH}
                  x2={MARGIN.left + tick.position * PLOT_WIDTH}
                  y1={MARGIN.top + PLOT_HEIGHT}
                  y2={MARGIN.top + PLOT_HEIGHT + 5}
                />
                <text
                  x={MARGIN.left + tick.position * PLOT_WIDTH}
                  y={MARGIN.top + PLOT_HEIGHT + 18}
                  textAnchor="middle"
                >
                  {tickLabel(x, tick.value)}
                </text>
              </g>
            ))}
            {yScale.ticks.map((tick) => (
              <g className="chart-tick" key={`y-${tick.value}`}>
                <line
                  x1={MARGIN.left - 5}
                  x2={MARGIN.left}
                  y1={MARGIN.top + (1 - tick.position) * PLOT_HEIGHT}
                  y2={MARGIN.top + (1 - tick.position) * PLOT_HEIGHT}
                />
                <text
                  x={MARGIN.left - 9}
                  y={MARGIN.top + (1 - tick.position) * PLOT_HEIGHT + 3}
                  textAnchor="end"
                >
                  {tickLabel(y, tick.value)}
                </text>
              </g>
            ))}

            {medianX !== null && (
              <g className="chart-median">
                <line
                  x1={screenX(medianX)}
                  x2={screenX(medianX)}
                  y1={MARGIN.top}
                  y2={MARGIN.top + PLOT_HEIGHT}
                />
                <text x={screenX(medianX)} y={MARGIN.top - 6} textAnchor="middle">
                  median
                </text>
              </g>
            )}
            {medianY !== null && (
              <g className="chart-median">
                <line
                  x1={MARGIN.left}
                  x2={MARGIN.left + PLOT_WIDTH}
                  y1={screenY(medianY)}
                  y2={screenY(medianY)}
                />
                <text x={MARGIN.left - 6} y={screenY(medianY) - 4} textAnchor="end">
                  median
                </text>
              </g>
            )}

            <text
              className="chart-axis-title"
              x={MARGIN.left + PLOT_WIDTH / 2}
              y={VIEW_HEIGHT - 8}
              textAnchor="middle"
            >
              {metricLabel(x)} · {metricDirectionLabel(x)}
            </text>
            <text
              className="chart-axis-title"
              transform={`rotate(-90 16 ${MARGIN.top + PLOT_HEIGHT / 2})`}
              x={16}
              y={MARGIN.top + PLOT_HEIGHT / 2}
              textAnchor="middle"
            >
              {metricLabel(y)} · {metricDirectionLabel(y)}
            </text>

            {points.map((point) => {
              const cx = screenX(point.x);
              const cy = screenY(point.y);
              const isActive = activePoint?.evaluationId === point.evaluationId;
              return (
                <g
                  className={`chart-point${isActive ? " is-active" : ""}`}
                  key={point.evaluationId}
                >
                  <circle cx={cx} cy={cy} r={POINT_RADIUS} fill={modelColor(point.modelAlias)} />
                </g>
              );
            })}
          </svg>

          <div className="chart-point-layer">
            {points.map((point) => (
              <button
                type="button"
                className="chart-point-button"
                key={point.evaluationId}
                aria-label={pointAriaLabel(point)}
                style={{
                  left: `${((screenX(point.x) / VIEW_WIDTH) * 100).toFixed(2)}%`,
                  top: `${((screenY(point.y) / VIEW_HEIGHT) * 100).toFixed(2)}%`,
                }}
                onMouseEnter={() => setActivePoint(point)}
                onMouseLeave={() => setActivePoint(null)}
                onFocus={() => setActivePoint(point)}
                onBlur={() => setActivePoint(null)}
                onClick={() => setActivePoint(point)}
              />
            ))}
          </div>

          {activePoint !== null && (
            <div
              className="chart-tooltip"
              aria-hidden="true"
              style={{
                left: `${((screenX(activePoint.x) / VIEW_WIDTH) * 100).toFixed(2)}%`,
                top: `${((screenY(activePoint.y) / VIEW_HEIGHT) * 100).toFixed(2)}%`,
              }}
            >
              <p className="chart-tooltip-title">{activePoint.modelAlias}</p>
              <p className="chart-tooltip-sub">reasoning {activePoint.reasoningMode}</p>
              <dl>
                <TooltipRow
                  label="Cost"
                  value={metricValueLabel("cost", activePoint.metrics.cost)}
                />
                <TooltipRow
                  label="Speed"
                  value={metricValueLabel("speed", activePoint.metrics.speed)}
                />
                <TooltipRow
                  label="Tokens"
                  value={metricValueLabel("tokens", activePoint.metrics.tokens)}
                />
                <TooltipRow
                  label="Pass rate"
                  value={metricValueLabel("pass", activePoint.metrics.pass)}
                />
                <TooltipRow label="Coverage" value={coverageLabel(activePoint.coverage)} />
                <TooltipRow label="Attempts" value={formatCount(activePoint.attempts)} />
              </dl>
            </div>
          )}
        </div>
      )}

      {excluded.length > 0 && (
        <div className="notice chart-warning" role="status">
          <h3>Excluded from the chart</h3>
          <ul>
            {excluded.map((item) => (
              <li key={item.evaluationId}>
                <span className="mono">{item.label}</span> — {chartExclusionText(item.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <figcaption className="footnote">
        Crosshairs mark the median of the visible points and are omitted below two points. Speed is
        the mean last-attempt request latency, where unresolved timeouts count as latencies; pass
        rate is correct / settled over the winning family.
      </figcaption>
    </figure>
  );
}
