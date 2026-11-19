export const wildfireId = '8ad4b895-5e4e-4995-82d0-c0f5078af365';
export function wildfireFeature(kind = 'incidents', id = 1) {
    const point = [-121.76, 46.85], ring = [[-121.80, 46.82], [-121.72, 46.82], [-121.72, 46.88], [-121.80, 46.88], [-121.80, 46.82]];
    return { type: 'Feature', properties: kind === 'incidents' ? { OBJECTID: id, IncidentTypeCategory: 'WF', IrwinID: `{${wildfireId}}`, IncidentName: 'Example Mountain Fire', IncidentSize: 74,
        PercentContained: 35, ModifiedOnDateTime_dt: Date.UTC(2026, 9, 24) } : { OBJECTID: id, attr_IncidentTypeCategory: 'WF', poly_IRWINID: wildfireId, attr_IrwinID: wildfireId, poly_IncidentName: 'Example Mountain Fire', poly_GISAcres: 74.1,
        poly_DateCurrent: Date.UTC(2026, 8, 20), poly_PolygonDateTime: Date.UTC(2026, 7, 1), attr_ModifiedOnDateTime_dt: Date.UTC(2026, 9, 24), attr_PercentContained: 35 },
    geometry: kind === 'incidents' ? { type: 'Point', coordinates: point } : { type: 'Polygon', coordinates: [ring, [[-121.78, 46.84], [-121.78, 46.86], [-121.74, 46.86], [-121.74, 46.84], [-121.78, 46.84]]] } };
}
export const wildfireFixture = (kind = 'incidents', count = 1) => ({ type: 'FeatureCollection', features: Array.from({ length: count }, (_, index) => wildfireFeature(kind, index + 1)) });
