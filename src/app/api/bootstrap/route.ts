import { NextResponse } from "next/server";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { stripConfigSecrets } from "@/lib/services/config-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const repository = getAppRepository();
  const scope = new URL(request.url).searchParams.get("scope");
  if (scope === "login") {
    const config = await repository.getConfig();
    return NextResponse.json({
      config: stripConfigSecrets(config)
    });
  }

  if (scope === "mobile") {
    const data = await repository.mobileBootstrap();
    return NextResponse.json({
      tickets: data.tickets,
      config: stripConfigSecrets(data.config)
    });
  }

  const state = await repository.adminBootstrap();
  return NextResponse.json({
    tickets: state.tickets,
    booths: state.booths,
    messageRecords: state.messageRecords,
    people: state.people ?? [],
    chatIdentities: state.chatIdentities ?? [],
    conversations: state.conversations ?? [],
    pendingWorkOrderSessions: state.pendingWorkOrderSessions ?? [],
    outboundMessages: state.outboundMessages ?? [],
    config: stripConfigSecrets(state.config)
  });
}
