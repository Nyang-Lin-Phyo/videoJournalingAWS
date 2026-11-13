import { Icon } from "./Icon";
export function ErrorNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="error-notice" role="alert">
      <Icon name="info" />
      <div>
        <p>{message}</p>
        {onRetry && (
          <button className="text-button" onClick={onRetry}>
            Try again <Icon name="refresh" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
export function Loading({ text = "Opening your journal…" }: { text?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {text}
    </div>
  );
}
