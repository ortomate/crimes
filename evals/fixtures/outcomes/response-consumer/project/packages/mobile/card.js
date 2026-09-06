import {userResponse} from "../api/user.js"; export const card=user=>({title:userResponse(user).name,id:user.id});
