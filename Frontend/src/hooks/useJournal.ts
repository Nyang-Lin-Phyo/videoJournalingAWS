import { useCallback, useEffect, useState } from "react";
import type { JournalApi, JournalDetail } from "../api/types";
import { isProcessing } from "../api/types";
import { errorMessage, isAbort } from "../api/errors";
export function useJournal(api: JournalApi, id: string) {
  const [journal, setJournal] = useState<JournalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(true);
  const refresh = useCallback(() => {
    setRefreshing(true);
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const result = await api.get(id, controller.signal);
        if (controller.signal.aborted) return;
        setJournal(result);
        setError(null);
        setRefreshing(false);
        if (isProcessing(result.status))
          timer = setTimeout(() => {
            void load();
          }, 2500);
      } catch (err) {
        if (!controller.signal.aborted && !isAbort(err)) {
          setError(errorMessage(err));
          setRefreshing(false);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, id, revision]);
  return { journal, error, refreshing, refresh };
}
