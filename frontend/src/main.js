import "../wailsjs/runtime/runtime.js";
import { ReqAPI } from '../wailsjs/go/main/App';

ReqAPI()
  .then(resp => {
    console.log("API responded:", resp);
    const respNode = document.createElement("p");
    resp.for
    respNode.textContent = "Response: " + resp;
    document.body.appendChild(respNode);
  })
  .catch(err => {
    console.error("API error:", err);
  });
