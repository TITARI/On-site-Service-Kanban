import { redirect } from "next/navigation";

export default async function TicketShortLinkPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  redirect(`/?ticketCode=${encodeURIComponent(code)}`);
}
