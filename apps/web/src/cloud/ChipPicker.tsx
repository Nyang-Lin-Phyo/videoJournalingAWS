import type { ChoiceOption } from "./profileCatalog";
import { Icon } from "../components/Icon";

type ChipPickerProps = {
  label: string;
  options: ChoiceOption[];
  selected: string[];
  max: number;
  onChange: (next: string[]) => void;
};

/** Multi-select chips (toggle buttons) with a visible selection limit. */
export function ChipPicker({ label, options, selected, max, onChange }: ChipPickerProps) {
  const full = selected.length >= max;
  return (
    <div className="chip-picker">
      <div className="chip-grid" role="group" aria-label={label}>
        {options.map(option => {
          const isOn = selected.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              className={`chip ${isOn ? "chip-on" : ""}`}
              aria-pressed={isOn}
              disabled={!isOn && full}
              onClick={() => onChange(isOn
                ? selected.filter(id => id !== option.id)
                : [...selected, option.id])}
            >
              {isOn && <Icon name="check" size={14} />}
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="chip-count" aria-live="polite">
        {selected.length} of {max} selected{full ? " · that's the most you can pick" : ""}
      </p>
    </div>
  );
}
