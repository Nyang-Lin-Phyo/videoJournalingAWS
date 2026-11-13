import type { JournalStatus as Status } from "../api/types";
const statusLabels: Record<Status, string> = {
  awaiting_upload: "Awaiting upload",
  queued: "Queued",
  transcribing: "Transcribing",
  analyzing: "Reflecting",
  completed: "Ready to revisit",
  failed: "Needs attention",
};
export function JournalStatus({ status }: { status: Status }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {statusLabels[status]}
    </span>
  );
}
