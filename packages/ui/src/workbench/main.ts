import "../styles/tailwind.css";
import { mount } from "svelte";
import Workbench from "./Workbench.svelte";

const target = document.querySelector<HTMLDivElement>("#app");
if (!target) throw new Error("UI_WORKBENCH_TARGET_MISSING");

mount(Workbench, { target });
