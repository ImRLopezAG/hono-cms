import { createFileRoute } from "@tanstack/react-router";
import { VisualizerCanvas } from "../components/visualizer/VisualizerCanvas";
import "../components/visualizer/visualizer.css";

export const Route = createFileRoute("/settings/content-types/visualizer")({
  component: ContentTypesVisualizerRoute
});

function ContentTypesVisualizerRoute() {
  return (
    <section className="hcms-vz" aria-labelledby="hcms-vz-title">
      <VisualizerCanvas
        header={
          <header className="hcms-vz-header">
            <div>
              <p className="hcms-vz-eyebrow">Content Types</p>
              <h1 id="hcms-vz-title" className="hcms-vz-title">Schema</h1>
              <p className="hcms-vz-subtitle">
                Click a collection to edit fields inline. Double-click the header to rename.
                Drag a handle to another node to declare a relation. For advanced options use
                the per-node <strong>Open form view</strong> button.
              </p>
            </div>
          </header>
        }
      />
    </section>
  );
}
