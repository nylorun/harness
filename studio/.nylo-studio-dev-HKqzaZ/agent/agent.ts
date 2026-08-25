import { Harness } from "@nylorun/harness";
import { Run } from "@nylorun/runtime/agent";
export default Run((options)=>new Harness(options),{name:"rebuilt",model:"anthropic/example"});
