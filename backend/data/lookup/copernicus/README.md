Cache local du fichier NetCDF Copernicus CDS couvrant la region PACA
(indicateurs climatiques sis-ecde-climate-indicators).

Ce fichier est telecharge automatiquement au premier appel de
app.connectors.copernicus.ensure_dataset_downloaded() - rien a placer ici
manuellement. Voir le docstring de app/connectors/copernicus.py pour la mise
en place du compte/jeton CDS (CDSAPI_URL / CDSAPI_KEY dans .env) necessaire
au telechargement.
