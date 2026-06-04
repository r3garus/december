import { createClient } from "@/lib/supabase/client";

export const getBackendAuthHeaders = async (): Promise<Record<string, string>> => {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {};
};
