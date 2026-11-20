import { Outlet } from "react-router-dom";
import { DevAuthBanner } from "./DevAuthBanner";
import { MobileHeader } from "./MobileHeader";
import { Sidebar } from "./Sidebar";

/** Layout for every signed-in screen: banner, navigation, and the page in a 1216px column. */
export function AppShell() {
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <DevAuthBanner />
      <div className="flex flex-1 flex-col lg:flex-row">
        <Sidebar />
        <MobileHeader />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
          <div className="mx-auto w-full max-w-content px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
