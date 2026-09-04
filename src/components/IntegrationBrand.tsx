import type { ReactNode } from 'react';
import proPresenterLogo from '../assets/integrations/propresenter.png';
import planningCenterLogo from '../assets/integrations/planning-center.png';
import slackLogo from '../assets/integrations/slack.png';
import youTubeLogo from '../assets/integrations/youtube.png';
import restreamLogo from '../assets/integrations/restream.png';
import resiLogo from '../assets/integrations/resi.svg';
import companionLogo from '../assets/integrations/companion.png';
import prodMeshLogo from '../assets/prodmesh-logo.svg';
import prodMeshRtaLogo from '../assets/integrations/prodmesh-rta.png';
import smaartLogo from '../assets/integrations/smaart.png';
import openSoundMeterLogo from '../assets/integrations/open-sound-meter.png';
import prodComLogo from '../assets/integrations/prodcom.png';
import obsLogo from '../assets/integrations/obs.png';

/** The integrations shown in Settings and in the widget picker. Keeping their
 * identity here means a widget and its configuration card always use the same
 * label, colour and compact brand mark. */
export type IntegrationId =
  | 'prodmesh' | 'propresenter' | 'planning-center' | 'restream' | 'resi'
  | 'youtube' | 'slack' | 'companion' | 'analysis' | 'captions'
  | 'prodmesh-rta' | 'smaart' | 'open-sound-meter' | 'prodcom' | 'obs';

export const integrationInfo: Record<IntegrationId, { name: string; mark: string; logo?: string; beta?: boolean }> = {
  prodmesh: { name: 'ProdMesh', mark: 'PM', logo: prodMeshLogo },
  propresenter: { name: 'ProPresenter', mark: 'P', logo: proPresenterLogo },
  'planning-center': { name: 'Planning Center', mark: 'PC', logo: planningCenterLogo },
  restream: { name: 'Restream', mark: 'R', logo: restreamLogo },
  resi: { name: 'Resi', mark: 'R', logo: resiLogo, beta: true },
  obs: { name: 'OBS Studio', mark: 'OBS', logo: obsLogo },
  youtube: { name: 'YouTube', mark: '▶', logo: youTubeLogo },
  slack: { name: 'Slack', mark: 'S', logo: slackLogo },
  companion: { name: 'Bitfocus Companion', mark: 'C', logo: companionLogo },
  analysis: { name: 'Audio analysis', mark: 'A' },
  'prodmesh-rta': { name: 'ProdMesh RTA', mark: 'R', logo: prodMeshRtaLogo },
  smaart: { name: 'Smaart', mark: 'S', logo: smaartLogo },
  'open-sound-meter': { name: 'Open Sound Meter', mark: 'OSM', logo: openSoundMeterLogo },
  // Captions is a built-in ProdMesh integration, so it deliberately carries
  // the same mark rather than looking like a separate third-party service.
  captions: { name: 'Captions', mark: 'PM', logo: prodMeshLogo },
  prodcom: { name: 'ProdCom', mark: 'P', logo: prodComLogo },
};

export function IntegrationBrand({ integration, label = false }: { integration: IntegrationId; label?: boolean }) {
  const info = integrationInfo[integration];
  return (
    <span className={`integration-brand integration-brand--${integration}`} title={info.name}>
      <span className={`integration-brand__mark${info.logo ? ' integration-brand__mark--image' : ''}`} aria-hidden>
        {info.logo ? <img src={info.logo} alt="" /> : info.mark}
      </span>
      {label && <span className="integration-brand__label">{info.name}</span>}
      {label && info.beta && <span className="integration-brand__beta">Beta</span>}
    </span>
  );
}

export function IntegrationBeta({ integration }: { integration: IntegrationId }) {
  return integrationInfo[integration].beta ? <span className="integration-brand__beta">Beta</span> : null;
}

export function IntegrationTitle({ integration, children }: { integration: IntegrationId; children: ReactNode }) {
  return <span className="integration-title"><IntegrationBrand integration={integration} />{children}<IntegrationBeta integration={integration} /></span>;
}
