import { encodeEventTopics, encodeAbiParameters } from "viem";

// Helper to encode event log for testing (simulates encodeEventLog from viem test utils)
export function encodeEventLog({
  abi,
  eventName,
  args,
}: {
  abi: any;
  eventName: string;
  args: Record<string, any>;
}): { data: `0x${string}`; topics: readonly `0x${string}`[] } {
  // Find the event in the ABI
  const abiEvent = abi.find((item: any) => item.name === eventName);
  if (!abiEvent) throw new Error(`Event ${eventName} not found in ABI`);

  // Encode topics: first topic is event selector, rest are indexed params
  const topics = encodeEventTopics({
    abi,
    eventName,
    args,
  }) as `0x${string}`[];

  // Encode non-indexed parameters as data
  const nonIndexedParams = abiEvent.inputs.filter((p: any) => !p.indexed);
  const nonIndexedArgs: Record<string, any> = {};
  for (const param of nonIndexedParams) {
    if (args[param.name] !== undefined) {
      nonIndexedArgs[param.name] = args[param.name];
    }
  }

  let data: `0x${string}` = "0x";
  if (nonIndexedParams.length > 0) {
    data = encodeAbiParameters(nonIndexedParams, Object.values(nonIndexedArgs));
  }

  return { topics, data };
}
