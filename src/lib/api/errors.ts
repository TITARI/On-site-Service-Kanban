import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function badRequest(message: string, details?: unknown) {
  return NextResponse.json({ message, details }, { status: 400 });
}

export async function parseJson(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new Error("请求体不是有效JSON");
  }
}

export function errorMessage(error: unknown) {
  if (error instanceof ZodError) return error.issues.map((issue) => issue.message).join("；");
  if (error instanceof Error) return error.message;
  return "请求参数无效";
}
