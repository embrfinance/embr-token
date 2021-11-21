# Embr token

## Contracts

### EmbrToken
The token uses OpenZeppelins ERC20 base contract and only adds a maximum supply of 250mio EMBR to it.

### EmbrMasterChef


The contract is based on SUSHI's version with some adjustments:
 - Upgrade to pragma 0.8.7
 - therefore remove usage of SafeMath (built in overflow check for solidity > 8)
 - Merge sushi's master chef V1 & V2 (no usage of dummy pool)
 - remove withdraw function (without harvest) => requires the rewardDebt to be an signed int instead of uint which requires a lot of casting and has no real usecase for us
 - no dev emissions, but treasury emissions instead
 - treasury percentage is subtracted from emissions instead of added on top
 - update of emission rate with upper limit of 6 EMBR/block
 - more require checks in general

## Tests
Tests are located under the `test/` directory. 

### Scripts:
 - `yarn test`  - Runs all tests
 - `yarn test:coverage` - Runs all tests with coverage report






