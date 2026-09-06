import {refund} from "./refund.js"; export const handle=(deps,id)=>refund(deps.db,deps.analytics,id);
