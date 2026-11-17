// Saltline on Azure: the game server on App Service, plus its own Microsoft-Decision-1.1 deployment on
// Microsoft Foundry. The app reaches the model with a user-assigned managed identity. The Foundry resource
// has key auth turned off, so there are no secrets to store or leak.
targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the azd environment. Names the resource group and seeds the unique resource names.')
param environmentName string

@minLength(1)
@description('Region for every resource. azd only offers regions with enough Microsoft-Decision-1.1 GlobalStandard quota for the default capacity.')
@metadata({
  azd: {
    type: 'location'
    usageName: [
      'AIServices.GlobalStandard.Microsoft-Decision-1.1,1000'
    ]
  }
})
param location string

@description('Object ID of the user or service principal running azd. It gets the same model access as the app, so `npm start` also works against this deployment.')
param principalId string = ''

@description('App Service plan SKU. P0v3 gives the single-process Node server a dedicated vCPU and 4 GB.')
param appServiceSku string = 'P0v3'

@description('Microsoft-Decision-1.1 deployment type. GlobalStandard has the widest region and quota availability; DataZoneStandard keeps processing inside the US or EU data zone.')
@allowed([
  'GlobalStandard'
  'DataZoneStandard'
])
param decisionSku string = 'GlobalStandard'

@description('Microsoft-Decision-1.1 capacity. One unit is 1 request and 1,000 tokens per minute; a fight with five machines uses about 110.')
@minValue(1)
param decisionCapacity int = 1000

var tags = { 'azd-env-name': environmentName }
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))

resource rg 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module resources 'resources.bicep' = {
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    principalId: principalId
    appServiceSku: appServiceSku
    decisionSku: decisionSku
    decisionCapacity: decisionCapacity
  }
}

output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = rg.name
// The server's own settings: `azd env get-values > .env` points a local `npm start` at this deployment.
output FOUNDRY_ENDPOINT string = resources.outputs.foundryEndpoint
output FOUNDRY_DEPLOYMENT string = resources.outputs.decisionDeployment
output SERVICE_WEB_NAME string = resources.outputs.webName
output SERVICE_WEB_URI string = resources.outputs.webUri
