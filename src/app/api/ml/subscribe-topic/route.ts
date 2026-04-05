import { NextRequest, NextResponse } from "next/server";
import { mlPut, mlGet } from "@/lib/ml";

/**
 * Subscribe to ML notification topics.
 * GET ?topic=claims  — adds topic to current subscription list
 * GET               — shows current topics
 */
export async function GET(req: NextRequest) {
  const topic = req.nextUrl.searchParams.get("topic");
  const appId = "4161083248428632";

  if (!topic) {
    const app = await mlGet<{ notification_topics: string[] }>(`/applications/${appId}`);
    return NextResponse.json({ topics: app?.notification_topics || [] });
  }

  // Get current topics
  const app = await mlGet<{ notification_topics: string[] }>(`/applications/${appId}`);
  const currentTopics = app?.notification_topics || [];

  if (currentTopics.includes(topic)) {
    return NextResponse.json({ status: "already_subscribed", topic, topics: currentTopics });
  }

  // Add new topic
  const newTopics = [...currentTopics, topic];
  const result = await mlPut(`/applications/${appId}`, { notification_topics: newTopics });

  if (result) {
    return NextResponse.json({ status: "ok", added: topic, topics: newTopics });
  }

  return NextResponse.json({ error: "Failed to update topics" }, { status: 502 });
}
