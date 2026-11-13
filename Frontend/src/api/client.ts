import { createHttpJournalApi } from "./httpClient";
import { mockJournalApi } from "../mocks/mockClient";
export const useMockApi = import.meta.env.VITE_USE_MOCK_API !== "false";
export const httpJournalApi = createHttpJournalApi(
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000",
);
export const journalApi = useMockApi ? mockJournalApi : httpJournalApi;
