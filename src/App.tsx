import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './layout/AppShell';
import { SetupGate } from './layout/SetupGate';
import { SundayTeam } from './pages/SundayTeam';
import { Home } from './pages/Home';
import { Services } from './pages/Services';
import { Calendar } from './pages/Calendar';
import { Analytics } from './pages/Analytics';
import { RoomStatus } from './pages/RoomStatus';
import { EventDetail } from './pages/EventDetail';
import { RoomShowRedirect } from './pages/RoomShowRedirect';
import { RunOfShow } from './pages/RunOfShow';
import { ServiceReport } from './pages/ServiceReport';
import { ViewsIndex } from './pages/ViewsIndex';
import { DashboardView } from './pages/DashboardView';
import { ViewEditorPage } from './pages/ViewEditorPage';
import { DisplayView } from './pages/DisplayView';
import { Settings } from './pages/Settings';
import { Setup } from './pages/Setup';
import './styles/index.css';

export default function App() {
  return (
    <SetupGate>
    <Routes>
      {/* First run — deliberately outside the shell: an unclaimed install has
          no campuses to navigate and no station to identify yet. */}
      <Route path="/setup" element={<Setup />} />
      {/* A display is not a page someone browses — it is what a screen on a
          wall shows. Outside the shell for the same reason /setup is: there is
          no sidebar to offer and nobody to click it. */}
      <Route path="/display/:roomId/:key" element={<DisplayView />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
        <Route path="/messages" element={<SundayTeam />} />
        <Route path="/sunday-team" element={<Navigate to="/messages" replace />} />
        <Route path="/services" element={<Services />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/admin" element={<Navigate to="/admin/general" replace />} />
        <Route path="/admin/general" element={<Settings section="general" />} />
        <Route path="/admin/integrations" element={<Settings section="integrations" />} />
        <Route path="/admin/users" element={<Settings section="users" />} />
        <Route path="/admin/stations" element={<Settings section="stations" />} />
        <Route path="/admin/checklists" element={<Settings section="checklists" />} />
        <Route path="/admin/campuses" element={<Settings section="campuses" />} />
        <Route path="/admin/campuses/:roomId" element={<Settings section="room" />} />
        <Route path="/admin/logs" element={<Settings section="logs" />} />
        {/* Room-level pages, reached from Home cards / Services rows.
            Room-Mac homepages point at /room/:id — these paths are stable. */}
        <Route path="/room/:roomId" element={<RoomStatus />} />
        <Route path="/room/:roomId/event/:planId" element={<EventDetail />} />
        <Route path="/room/:roomId/show" element={<RoomShowRedirect />} />
        <Route path="/room/:roomId/run/:planId" element={<RunOfShow />} />
        <Route path="/room/:roomId/run/:planId/report" element={<ServiceReport />} />
        <Route path="/room/:roomId/views" element={<ViewsIndex />} />
        <Route path="/room/:roomId/view/:slug" element={<DashboardView />} />
        <Route path="/room/:roomId/view/:slug/edit" element={<ViewEditorPage />} />
        {/* Old bookmark */}
        <Route path="/settings" element={<Navigate to="/admin/general" replace />} />
      </Route>
    </Routes>
    </SetupGate>
  );
}
