// Finance agent (Ledger): the generic Jev handbook guard (see jev-guard.mjs), fed this agent's own
// policy manual. finance-policies.mjs keeps the exact rules as a floor for when Jev is unavailable.
import { customPolicies, allow, deny } from "failproofai";
import { createWorld } from "../../world.mjs";
import { jevGuard, handbookText } from "./jev-guard.mjs";

customPolicies.add(jevGuard({ server: "finance", handbook: handbookText(createWorld()), searchTool: "search_policy", allow, deny }));
