import { TIME_RANGE } from "@/lib/config";
import { formatMinutes, koreaNow } from "@/lib/sun";
import styles from "./TimeSlider.module.css";

interface Props {
  date: string;
  minutes: number;
  onDateChange: (d: string) => void;
  onMinutesChange: (m: number) => void;
}

export default function TimeSlider({ date, minutes, onDateChange, onMinutesChange }: Props) {
  const { startMinutes, endMinutes, stepMinutes } = TIME_RANGE;
  const pct = ((minutes - startMinutes) / (endMinutes - startMinutes)) * 100;

  return (
    <div className={styles.wrap}>
      <div className={styles.caption}>산책할 날짜와 시간 <span>한국 시간 · 07–19시</span></div>
      <div className={styles.row}>
        <input
          type="date"
          className={styles.date}
          value={date}
          onChange={(e) => e.target.value && onDateChange(e.target.value)}
          aria-label="날짜"
        />
        <div className={styles.time} aria-live="polite">
          {formatMinutes(minutes)}
        </div>
        <button
          type="button"
          className={styles.now}
          title="오늘의 현재 시각으로 이동합니다. 운영 범위 밖의 시간은 07시 또는 19시로 맞춥니다."
          onClick={() => {
            const n = koreaNow();
            const snapped = Math.round(n.minutes / stepMinutes) * stepMinutes;
            onDateChange(n.date);
            onMinutesChange(Math.min(endMinutes, Math.max(startMinutes, snapped)));
          }}
        >
          오늘
        </button>
      </div>
      <div className={styles.sliderRow}>
        <span className={styles.tick}>{formatMinutes(startMinutes)}</span>
        <div className={styles.sliderBox}>
          <input
            type="range"
            className={styles.slider}
            min={startMinutes}
            max={endMinutes}
            step={stepMinutes}
            value={minutes}
            onChange={(e) => onMinutesChange(Number(e.target.value))}
            aria-label="시간"
            aria-valuetext={formatMinutes(minutes)}
            style={{ ["--pct" as string]: `${pct}%` }}
          />
        </div>
        <span className={styles.tick}>{formatMinutes(endMinutes)}</span>
      </div>
    </div>
  );
}
