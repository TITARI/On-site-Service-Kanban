import { getAppRepository, type AppRepository } from "@/lib/repositories/app-repository";
import {
  claimOutboundInputSchema,
  completeOutboundInputSchema,
  registerAgentInputSchema,
  submitEventsInputSchema
} from "./contracts";

export function createWxautoIntegrationService(repository: AppRepository = getAppRepository()) {
  return {
    registerAgent: (input: unknown) => repository.registerWxautoAgent(registerAgentInputSchema.parse(input)),
    submitEvents: (input: unknown) => repository.submitWxautoEvents(submitEventsInputSchema.parse(input)),
    claimOutbound: (input: unknown) => repository.claimWxautoOutbound(claimOutboundInputSchema.parse(input)),
    completeOutbound: (input: unknown) => repository.completeWxautoOutbound(completeOutboundInputSchema.parse(input))
  };
}
